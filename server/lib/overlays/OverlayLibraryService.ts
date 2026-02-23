import ImdbRatingsAPI from '@server/api/imdbRatings';
import type { MaintainerrCollection } from '@server/api/maintainerr';
import type { PlexLibraryItem } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import type { RadarrMovie } from '@server/api/servarr/radarr';
import type { SonarrSeries } from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import { getRepository } from '@server/datasource';
import { OverlayLibraryConfig } from '@server/entity/OverlayLibraryConfig';
import { OverlayTemplate } from '@server/entity/OverlayTemplate';
import cacheManager from '@server/lib/cache';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type sharp from 'sharp';
import {
  capTtlForRecentRelease,
  getAdaptiveTtl,
  getNullRatingTtl,
} from './adaptiveTtl';
import {
  buildRenderContext,
  checkMonitoringStatus,
  fetchReleaseDateInfo,
  type ReleaseDateInfo,
} from './OverlayContextBuilder';
import type { OverlayRenderContext } from './OverlayTemplateRenderer';
import {
  evaluateCondition,
  overlayTemplateRenderer,
} from './OverlayTemplateRenderer';

/**
 * Input for overlay application - either a simple rating key or with context overrides
 */
export interface OverlayItemInput {
  ratingKey: string;
  contextOverrides?: Partial<OverlayRenderContext>;
}

// TmdbReleaseDateInfo is now imported as ReleaseDateInfo from OverlayContextBuilder

/**
 * Job state machine states
 */
export type JobState =
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed';

/**
 * Internal progress tracking for a library overlay job
 */
interface LibraryProgress {
  // Identity
  libraryName: string;
  startTime: number;

  // State machine
  state: JobState;
  completedAt?: number; // For TTL cleanup after completion

  // Progress
  totalItems: number;
  currentItem: number;
  currentTitle: string;
  filteredCount: number; // Episodes/seasons skipped by type filter

  // Outcome counts
  // INVARIANT: successCount + errorCount + skippedCount + filteredCount === currentItem
  successCount: number;
  errorCount: number;
  skippedCount: number; // Items with no changes (hash matched)

  // ETA calculation (private, not serialized)
  _recentItemTimes: number[]; // Rolling window of last 20 item timestamps
  _promise: Promise<void>; // For mutex, not serialized
}

/**
 * Public status shape returned by API
 */
export interface LibraryStatus {
  running: boolean;
  state: JobState;
  libraryName: string;
  startTime: number;
  runningFor: number;
  totalItems: number;
  currentItem: number;
  currentTitle: string;
  filteredCount: number;
  successCount: number;
  errorCount: number;
  skippedCount: number;
  progressPercent: number; // Clamped 0-100
  estimatedSecondsRemaining: number | null; // Capped at 7200 (2h)
}

/**
 * Result from applying overlays to a single item
 */
interface OverlayApplyResult {
  skipped: boolean; // true if nothing changed (hash match)
}

/**
 * Service for applying overlay templates to Plex library items
 */
class OverlayLibraryService {
  // Cache for Radarr/Sonarr library data (global, keyed by instance URL)
  // These are shared across libraries since Radarr/Sonarr data is the same regardless of Plex library
  private radarrMoviesCache?: Map<string, RadarrMovie[]>;
  private sonarrSeriesCache?: Map<string, SonarrSeries[]>;
  private maintainerrCollectionsCache?: MaintainerrCollection[];
  // Maps item ratingKey → array of collection IDs the item belongs to
  private collectionMembershipCache?: Map<string, string[]>;

  // Pre-fetched IMDb ratings for batch optimization (global, keyed by IMDb ID)
  // Maps IMDb ID to rating number (or null if no rating available).
  // Populated before item processing loop. Null means "checked, no rating".
  // Shared across concurrent library processing since IMDb ratings are global.
  private preloadedImdbRatings?: Map<string, number | null>;

  // Pre-fetched TMDB release date info for batch optimization (global, keyed by tmdbId:mediaType)
  // Maps to release date info object (or null if not found).
  // Populated before item processing loop. Null means "checked, no data".
  // Shared across concurrent library processing since TMDB data is global.
  private preloadedTmdbReleaseDates?: Map<string, ReleaseDateInfo | null>;

  // Pre-analyzed required context fields from all enabled templates (per-library)
  // Keyed by libraryId since different libraries can have different templates enabled.
  // Used to skip unnecessary API calls (e.g., skip RT if no template uses RT ratings)
  private requiredContextFieldsByLibrary = new Map<string, Set<string>>();

  // Track running libraries with mutex-like behavior and detailed progress
  // Prevents concurrent processing of the same library
  private runningLibraries = new Map<string, LibraryProgress>();

  // Track libraries that have been requested to cancel
  private cancelledLibraries = new Set<string>();

  // TTL for completed jobs (visible to UI before cleanup)
  private static readonly COMPLETED_TTL_MS = 10_000;

  /**
   * Request cancellation of a library overlay job
   * Returns 'requested' if newly requested, 'already' if already cancelling, 'not_found' otherwise
   */
  public requestCancellation(
    libraryId: string
  ): 'requested' | 'already' | 'not_found' {
    const progress = this.runningLibraries.get(libraryId);
    if (!progress) {
      return 'not_found';
    }
    if (progress.state === 'cancelling') {
      return 'already'; // Idempotent - already in progress
    }
    if (progress.state === 'running') {
      this.cancelledLibraries.add(libraryId);
      progress.state = 'cancelling';
      return 'requested';
    }
    return 'not_found'; // Job completed/failed/cancelled
  }

  /**
   * Safely update progress for a library (while running or cancelling)
   * Allows final progress updates during cancellation to maintain count accuracy
   */
  private updateProgress(
    libraryId: string,
    mutator: (progress: LibraryProgress) => void
  ): void {
    const progress = this.runningLibraries.get(libraryId);
    if (
      progress &&
      (progress.state === 'running' || progress.state === 'cancelling')
    ) {
      mutator(progress);
    }
  }

  /**
   * Clean up completed jobs after TTL expires
   */
  private cleanupCompletedJobs(): void {
    const now = Date.now();
    for (const [id, status] of this.runningLibraries) {
      if (
        status.completedAt &&
        now - status.completedAt > OverlayLibraryService.COMPLETED_TTL_MS
      ) {
        this.runningLibraries.delete(id);
      }
    }
  }

  /**
   * Clear global caches when no jobs are running to prevent memory leaks.
   * Called after each job completes to release memory when idle.
   */
  private clearGlobalCachesIfIdle(): void {
    // Check if any library is currently running or cancelling
    const hasActiveJobs = Array.from(this.runningLibraries.values()).some(
      (p) => p.state === 'running' || p.state === 'cancelling'
    );

    if (!hasActiveJobs) {
      logger.debug('No active overlay jobs, clearing global caches', {
        label: 'OverlayLibrary',
        clearedCaches: [
          this.radarrMoviesCache ? 'radarr' : null,
          this.sonarrSeriesCache ? 'sonarr' : null,
          this.preloadedImdbRatings ? 'imdb' : null,
          this.preloadedTmdbReleaseDates ? 'tmdb' : null,
          this.maintainerrCollectionsCache ? 'maintainerr' : null,
        ].filter(Boolean),
      });
      this.radarrMoviesCache = undefined;
      this.sonarrSeriesCache = undefined;
      this.maintainerrCollectionsCache = undefined;
      this.preloadedImdbRatings = undefined;
      this.preloadedTmdbReleaseDates = undefined;
    }
  }

  /**
   * Pre-fetch IMDb ratings for all items in the library using batch API calls
   * with adaptive TTL caching based on content age.
   *
   * Optimizations:
   * 1. Extract IMDb IDs directly from Plex GUIDs (skips TMDB entirely for most items)
   * 2. Only call TMDB as fallback for items without IMDb GUIDs
   * 3. Deduplicate IDs before fetching
   * 4. Check adaptive cache before API calls
   * 5. Cache null ratings to avoid repeated lookups
   * 6. Store results with age-appropriate TTL (12h to 30 days)
   *
   * @param items - All items from the library
   */
  private async prefetchImdbRatings(items: PlexLibraryItem[]): Promise<void> {
    const startTime = Date.now();

    // CRITICAL: Ensure Map exists to prevent silent fallback to individual API calls
    // If this Map is undefined, buildRenderContext will make individual calls for every item
    // Reuse existing Map if present (from another library's concurrent prefetch) to avoid
    // wiping another library's data while it's still processing items
    if (!this.preloadedImdbRatings) {
      this.preloadedImdbRatings = new Map();
    }

    try {
      const cacheEntry = cacheManager.getCache('imdb-ratings');
      if (!cacheEntry?.data) {
        logger.error(
          'IMDb ratings cache not available - prefetch cannot proceed',
          {
            label: 'OverlayLibrary',
            cacheExists: !!cacheEntry,
          }
        );
        return; // Map is empty but initialized, items will make individual calls
      }
      const adaptiveCache = cacheEntry.data;

      // Filter to movies/shows only (skip episodes/seasons)
      const processableItems = items.filter(
        (item) => item.type === 'movie' || item.type === 'show'
      );

      if (processableItems.length === 0) {
        logger.debug('No items to prefetch IMDb ratings for', {
          label: 'OverlayLibrary',
        });
        return;
      }

      // Step 1: Extract IMDb IDs from Plex GUIDs first (fast path - no API calls)
      // Only fall back to TMDB for items without IMDb GUIDs
      const imdbData: Map<
        string,
        { imdbId: string; releaseYear: number | undefined }
      > = new Map();
      const needTmdbLookup: {
        tmdbId: number;
        itemType: 'movie' | 'show';
        year?: number;
      }[] = [];
      let plexImdbCount = 0;

      for (const item of processableItems) {
        if (!item.Guid || !Array.isArray(item.Guid)) continue;

        // Try to find IMDb ID directly in Plex GUIDs
        const imdbGuid = item.Guid.find((g) => g.id?.startsWith('imdb://'));
        if (imdbGuid) {
          const imdbId = imdbGuid.id.replace('imdb://', '');
          if (imdbId && !imdbData.has(imdbId)) {
            imdbData.set(imdbId, { imdbId, releaseYear: item.year });
            plexImdbCount++;
          }
          continue; // Got IMDb ID, no need for TMDB
        }

        // No IMDb GUID - check if we have TMDB ID for fallback lookup
        const tmdbGuid = item.Guid.find((g) => g.id?.startsWith('tmdb://'));
        if (tmdbGuid) {
          const match = tmdbGuid.id.match(/tmdb:\/\/(\d+)/);
          if (match) {
            const tmdbId = parseInt(match[1], 10);
            // Deduplicate TMDB lookups
            if (!needTmdbLookup.some((t) => t.tmdbId === tmdbId)) {
              const itemType = item.type === 'movie' ? 'movie' : 'show';
              needTmdbLookup.push({ tmdbId, itemType, year: item.year });
            }
          }
        }
      }

      logger.info('Pre-fetching IMDb ratings with adaptive TTL', {
        label: 'OverlayLibrary',
        totalItems: items.length,
        processableItems: processableItems.length,
        imdbFromPlex: plexImdbCount,
        needTmdbLookup: needTmdbLookup.length,
      });

      // Step 2: Fetch TMDB data only for items without IMDb GUIDs
      if (needTmdbLookup.length > 0) {
        const tmdbClient = new TheMovieDb();
        const batchSize = 20;
        let tmdbFailures = 0;

        for (let i = 0; i < needTmdbLookup.length; i += batchSize) {
          const batch = needTmdbLookup.slice(i, i + batchSize);

          const promises = batch.map(async ({ tmdbId, itemType, year }) => {
            try {
              const tmdbResult =
                itemType === 'movie'
                  ? await tmdbClient.getMovie({ movieId: tmdbId })
                  : await tmdbClient.getTvShow({ tvId: tmdbId });

              const imdbId = tmdbResult.external_ids?.imdb_id;
              if (!imdbId) return undefined;

              // Use TMDB release date if available, otherwise fall back to Plex year
              let releaseYear = year;
              if ('release_date' in tmdbResult && tmdbResult.release_date) {
                releaseYear = parseInt(
                  tmdbResult.release_date.substring(0, 4),
                  10
                );
              } else if (
                'first_air_date' in tmdbResult &&
                tmdbResult.first_air_date
              ) {
                releaseYear = parseInt(
                  tmdbResult.first_air_date.substring(0, 4),
                  10
                );
              }

              return { imdbId, releaseYear };
            } catch {
              tmdbFailures++;
              return undefined;
            }
          });

          const results = await Promise.all(promises);
          for (const result of results) {
            if (result && !imdbData.has(result.imdbId)) {
              imdbData.set(result.imdbId, result);
            }
          }
        }

        if (tmdbFailures > 0) {
          logger.debug('Some TMDB lookups failed during prefetch', {
            label: 'OverlayLibrary',
            failures: tmdbFailures,
            attempted: needTmdbLookup.length,
          });
        }
      }

      logger.debug('Collected IMDb IDs for rating lookup', {
        label: 'OverlayLibrary',
        totalImdbIds: imdbData.size,
        fromPlex: plexImdbCount,
        fromTmdb: imdbData.size - plexImdbCount,
      });

      if (imdbData.size === 0) {
        // Map already initialized at function start
        return;
      }

      // Step 3: Check adaptive cache for existing ratings
      // Map already initialized at function start, just populate it
      const uncachedItems: {
        imdbId: string;
        releaseYear: number | undefined;
      }[] = [];
      let cacheHits = 0;
      let nullCacheHits = 0;

      for (const [imdbId, data] of imdbData) {
        const cachedRating = adaptiveCache.get<number | null>(imdbId);
        if (cachedRating !== undefined) {
          // Store in preloadedImdbRatings (including null) to prevent fallback API calls
          this.preloadedImdbRatings.set(imdbId, cachedRating);
          if (cachedRating === null) {
            nullCacheHits++;
          }
          cacheHits++;
        } else {
          // Need to fetch this one
          uncachedItems.push(data);
        }
      }

      logger.debug('Adaptive cache check complete', {
        label: 'OverlayLibrary',
        totalItems: imdbData.size,
        cacheHits,
        nullCacheHits,
        cacheMisses: uncachedItems.length,
      });

      // Step 4: Batch fetch only uncached IMDb ratings
      if (uncachedItems.length > 0) {
        try {
          const imdbApi = new ImdbRatingsAPI();
          const imdbIds = uncachedItems.map((item) => item.imdbId);
          const ratings = await imdbApi.getRatings(imdbIds);

          // Create lookup map for release years
          const releaseYearMap = new Map<string, number | undefined>();
          for (const item of uncachedItems) {
            releaseYearMap.set(item.imdbId, item.releaseYear);
          }

          // Track which IDs got ratings
          const receivedIds = new Set<string>();

          // Step 5: Store each rating with age-appropriate TTL
          for (const rating of ratings) {
            receivedIds.add(rating.imdbId);
            const releaseYear = releaseYearMap.get(rating.imdbId);
            const ttl = getAdaptiveTtl(releaseYear);

            if (rating.rating !== null) {
              this.preloadedImdbRatings.set(rating.imdbId, rating.rating);
              adaptiveCache.set(rating.imdbId, rating.rating, ttl);
            } else {
              // Cache null rating with adaptive TTL based on content age
              const nullTtl = getNullRatingTtl(releaseYear);
              this.preloadedImdbRatings.set(rating.imdbId, null);
              adaptiveCache.set(rating.imdbId, null, nullTtl);
            }
          }

          // Cache any IDs that weren't in the response as null
          for (const item of uncachedItems) {
            if (!receivedIds.has(item.imdbId)) {
              const nullTtl = getNullRatingTtl(item.releaseYear);
              this.preloadedImdbRatings.set(item.imdbId, null);
              adaptiveCache.set(item.imdbId, null, nullTtl);
            }
          }

          const elapsed = Date.now() - startTime;
          const apiCalls = Math.ceil(uncachedItems.length / 100);
          logger.info('Pre-fetched IMDb ratings successfully', {
            label: 'OverlayLibrary',
            totalImdbIds: imdbData.size,
            fromPlexGuids: plexImdbCount,
            fromTmdbLookup: imdbData.size - plexImdbCount,
            cacheHits,
            fetchedFromApi: uncachedItems.length,
            ratingsReceived: this.preloadedImdbRatings.size,
            batchApiCalls: apiCalls,
            elapsedMs: elapsed,
          });
        } catch (error) {
          // Don't fail the job if pre-fetch fails - items will fall back to individual calls
          logger.warn(
            'Failed to pre-fetch IMDb ratings, will use individual calls',
            {
              label: 'OverlayLibrary',
              error: error instanceof Error ? error.message : String(error),
            }
          );
          // Keep any cached ratings we found
        }
      } else {
        const elapsed = Date.now() - startTime;
        logger.info('All IMDb ratings served from cache', {
          label: 'OverlayLibrary',
          totalImdbIds: imdbData.size,
          cacheHits,
          nullCacheHits,
          elapsedMs: elapsed,
        });
      }
    } catch (error) {
      // Outer catch: handle any unexpected errors during prefetch setup
      // The Map is already initialized, so items can still use it (even if empty)
      const elapsed = Date.now() - startTime;
      logger.error('IMDb prefetch failed unexpectedly', {
        label: 'OverlayLibrary',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        elapsedMs: elapsed,
        preloadedCount: this.preloadedImdbRatings?.size ?? 0,
      });
      // Don't rethrow - job can continue with individual API calls as fallback
    }
  }

  /**
   * Pre-fetch TMDB release date info for all items in the library.
   * Uses concurrency-limited parallel fetching since TMDB has no batch API.
   * Results are cached with adaptive TTL based on content age.
   */
  private async prefetchTmdbReleaseDates(
    items: PlexLibraryItem[]
  ): Promise<void> {
    const startTime = Date.now();

    // Reuse existing Map if present to avoid wiping another library's data
    if (!this.preloadedTmdbReleaseDates) {
      this.preloadedTmdbReleaseDates = new Map();
    }

    try {
      const cacheEntry = cacheManager.getCache('tmdb-releases');
      if (!cacheEntry?.data) {
        logger.error(
          'TMDB releases cache not available - prefetch cannot proceed',
          {
            label: 'OverlayLibrary',
            cacheExists: !!cacheEntry,
          }
        );
        return;
      }
      const adaptiveCache = cacheEntry.data;

      // Filter to movies/shows only (skip episodes/seasons)
      const processableItems = items.filter(
        (item) => item.type === 'movie' || item.type === 'show'
      );

      if (processableItems.length === 0) {
        logger.debug('No items to prefetch TMDB release dates for', {
          label: 'OverlayLibrary',
        });
        return;
      }

      // Extract TMDB IDs from Plex GUIDs
      const tmdbItems: {
        tmdbId: number;
        mediaType: 'movie' | 'show';
        year?: number;
      }[] = [];
      const seen = new Set<string>();

      for (const item of processableItems) {
        if (!item.Guid || !Array.isArray(item.Guid)) continue;

        const tmdbGuid = item.Guid.find((g) => g.id?.startsWith('tmdb://'));
        if (tmdbGuid) {
          const match = tmdbGuid.id.match(/tmdb:\/\/(\d+)/);
          if (match) {
            const tmdbId = parseInt(match[1], 10);
            const mediaType = item.type === 'movie' ? 'movie' : 'show';
            const cacheKey = `${tmdbId}:${mediaType}`;

            if (!seen.has(cacheKey)) {
              seen.add(cacheKey);
              tmdbItems.push({ tmdbId, mediaType, year: item.year });
            }
          }
        }
      }

      logger.info('Pre-fetching TMDB release dates', {
        label: 'OverlayLibrary',
        totalItems: items.length,
        processableItems: processableItems.length,
        uniqueTmdbIds: tmdbItems.length,
      });

      if (tmdbItems.length === 0) {
        return;
      }

      // Check cache for existing entries
      const uncachedItems: typeof tmdbItems = [];
      let cacheHits = 0;
      let nullCacheHits = 0;

      for (const item of tmdbItems) {
        const cacheKey = `${item.tmdbId}:${item.mediaType}`;
        const cached = adaptiveCache.get<ReleaseDateInfo | null>(cacheKey);

        if (cached !== undefined) {
          this.preloadedTmdbReleaseDates.set(cacheKey, cached);
          logger.debug('Prefetch: cache HIT', {
            label: 'OverlayLibrary',
            cacheKey,
            releaseDate: cached?.releaseDate ?? 'null',
          });
          if (cached === null) {
            nullCacheHits++;
          }
          cacheHits++;
        } else {
          uncachedItems.push(item);
        }
      }

      logger.debug('TMDB release date cache check complete', {
        label: 'OverlayLibrary',
        totalItems: tmdbItems.length,
        cacheHits,
        nullCacheHits,
        cacheMisses: uncachedItems.length,
      });

      // Fetch uncached items with concurrency limit
      if (uncachedItems.length > 0) {
        const tmdbClient = new TheMovieDb();
        const concurrency = 10; // Parallel requests at a time
        let fetchSuccess = 0;
        let fetchFailures = 0;

        // Capture reference for use in async callbacks (TypeScript flow analysis)
        const preloadedMap = this.preloadedTmdbReleaseDates;

        // Process in batches with concurrency limit
        for (let i = 0; i < uncachedItems.length; i += concurrency) {
          const batch = uncachedItems.slice(i, i + concurrency);

          const promises = batch.map(async ({ tmdbId, mediaType, year }) => {
            const cacheKey = `${tmdbId}:${mediaType}`;
            try {
              let releaseDateInfo: ReleaseDateInfo | null = null;

              if (mediaType === 'movie') {
                const movieDetails = await tmdbClient.getMovie({
                  movieId: tmdbId,
                });

                // Extract release date using the same logic as fetchReleaseDateInfo
                if (movieDetails.release_dates?.results) {
                  const { extractReleaseDates, determineReleaseDate } =
                    await import('@server/utils/dateHelpers');
                  const extracted = extractReleaseDates(
                    movieDetails.release_dates.results
                  );
                  const determined = determineReleaseDate(
                    extracted.digitalRelease,
                    extracted.physicalRelease,
                    extracted.inCinemas
                  );
                  if (determined) {
                    releaseDateInfo = { releaseDate: determined.releaseDate };
                    logger.debug('Prefetch: determined release date', {
                      label: 'OverlayLibrary',
                      tmdbId,
                      releaseDate: determined.releaseDate,
                      isEstimated: determined.isEstimated,
                      digitalRelease: extracted.digitalRelease,
                      physicalRelease: extracted.physicalRelease,
                      inCinemas: extracted.inCinemas,
                    });
                  }
                }

                // Fallback to simple release_date
                if (!releaseDateInfo && movieDetails.release_date) {
                  releaseDateInfo = { releaseDate: movieDetails.release_date };
                }
              } else {
                // TV show
                const showDetails = await tmdbClient.getTvShow({
                  tvId: tmdbId,
                });
                const nextEpisode = showDetails.next_episode_to_air;

                if (nextEpisode?.air_date) {
                  releaseDateInfo = {
                    // Set releaseDate from first_air_date (matches original fetchReleaseDateInfo)
                    releaseDate:
                      showDetails.first_air_date || nextEpisode.air_date,
                    nextEpisodeAirDate: nextEpisode.air_date,
                    seasonNumber: nextEpisode.season_number,
                    episodeNumber: nextEpisode.episode_number,
                  };

                  // Check for season premiere
                  if (nextEpisode.episode_number === 1) {
                    releaseDateInfo.nextSeasonAirDate = nextEpisode.air_date;
                  }
                } else {
                  // TMDB doesn't have next_episode_to_air
                  // Don't cache null - let per-item call try Sonarr fallback
                  // This avoids suppressing the Sonarr fallback logic in fetchReleaseDateInfo
                  return; // Skip caching, will be handled per-item
                }
              }

              // Cache the result with adaptive TTL, capped for recent releases
              const baseTtl = getAdaptiveTtl(year);
              const ttl = capTtlForRecentRelease(
                releaseDateInfo?.releaseDate,
                baseTtl
              );
              if (releaseDateInfo) {
                preloadedMap?.set(cacheKey, releaseDateInfo);
                adaptiveCache.set(cacheKey, releaseDateInfo, ttl);
                fetchSuccess++;
              } else {
                // For movies without release dates, cache null
                const nullTtl = getNullRatingTtl(year);
                preloadedMap?.set(cacheKey, null);
                adaptiveCache.set(cacheKey, null, nullTtl);
              }
            } catch (error) {
              fetchFailures++;
              // Only cache null for movies - TV shows need Sonarr fallback opportunity
              if (mediaType === 'movie') {
                const nullTtl = getNullRatingTtl(year);
                preloadedMap?.set(cacheKey, null);
                adaptiveCache.set(cacheKey, null, nullTtl);
              }
              logger.debug('TMDB prefetch failed for item', {
                label: 'OverlayLibrary',
                tmdbId,
                mediaType,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          });

          await Promise.all(promises);
        }

        const elapsed = Date.now() - startTime;
        logger.info('Pre-fetched TMDB release dates successfully', {
          label: 'OverlayLibrary',
          totalTmdbIds: tmdbItems.length,
          cacheHits,
          fetchedFromApi: uncachedItems.length,
          fetchSuccess,
          fetchFailures,
          preloadedCount: this.preloadedTmdbReleaseDates.size,
          elapsedMs: elapsed,
        });
      } else {
        const elapsed = Date.now() - startTime;
        logger.info('All TMDB release dates served from cache', {
          label: 'OverlayLibrary',
          totalTmdbIds: tmdbItems.length,
          cacheHits,
          nullCacheHits,
          elapsedMs: elapsed,
        });
      }
    } catch (error) {
      const elapsed = Date.now() - startTime;
      logger.error('TMDB release date prefetch failed unexpectedly', {
        label: 'OverlayLibrary',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        elapsedMs: elapsed,
        preloadedCount: this.preloadedTmdbReleaseDates?.size ?? 0,
      });
      // Don't rethrow - job can continue with individual API calls as fallback
    }
  }

  /**
   * Calculate ETA using rolling average of recent item times
   * Returns null if not enough data, caps at 2 hours
   */
  private calculateEta(progress: LibraryProgress): number | null {
    const times = progress._recentItemTimes;

    // Need at least 5 samples and library must have 20+ items
    if (times.length < 5 || progress.totalItems < 20) {
      return null;
    }

    // Calculate average ms per item from rolling window
    const windowDuration = times[times.length - 1] - times[0];
    const avgMsPerItem = windowDuration / (times.length - 1);

    // Estimate remaining time
    const remaining = progress.totalItems - progress.currentItem;
    const etaMs = remaining * avgMsPerItem;

    // Cap at 2 hours (7200 seconds)
    return Math.min(7200, Math.round(etaMs / 1000));
  }

  /**
   * Get status for a specific library
   */
  public getLibraryStatus(
    libraryId: string
  ): LibraryStatus | { running: false } {
    // Clean up expired entries first
    this.cleanupCompletedJobs();

    const progress = this.runningLibraries.get(libraryId);
    if (!progress) {
      return { running: false };
    }

    const runningFor = Math.round((Date.now() - progress.startTime) / 1000);

    // Calculate progress percent (clamped 0-100)
    const rawPercent =
      progress.totalItems > 0
        ? (progress.currentItem / progress.totalItems) * 100
        : 0;
    const progressPercent = Math.min(100, Math.max(0, Math.round(rawPercent)));

    // Calculate ETA
    const estimatedSecondsRemaining = this.calculateEta(progress);

    // Return cloned status object
    return {
      running: progress.state === 'running' || progress.state === 'cancelling',
      state: progress.state,
      libraryName: progress.libraryName,
      startTime: progress.startTime,
      runningFor,
      totalItems: progress.totalItems,
      currentItem: progress.currentItem,
      currentTitle: progress.currentTitle,
      filteredCount: progress.filteredCount,
      successCount: progress.successCount,
      errorCount: progress.errorCount,
      skippedCount: progress.skippedCount,
      progressPercent,
      estimatedSecondsRemaining,
    };
  }

  /**
   * Get all running libraries with full status
   */
  public getAllRunningLibraries(): (LibraryStatus & { libraryId: string })[] {
    this.cleanupCompletedJobs();

    return Array.from(this.runningLibraries.entries())
      .map(([libraryId]) => {
        const status = this.getLibraryStatus(libraryId);
        if ('state' in status) {
          return { libraryId, ...status };
        }
        return null;
      })
      .filter((s): s is LibraryStatus & { libraryId: string } => s !== null);
  }

  /**
   * Initialize caches if needed (call at start of overlay job)
   * Note: We no longer clear caches here because they're either:
   * - Global (Radarr/Sonarr/Maintainerr/IMDb data) - shared across libraries
   * - Per-library scoped (requiredContextFields) - keyed by libraryId
   * Clearing would wipe another concurrent library's data.
   */
  private initializeCachesIfNeeded() {
    // Initialize global caches only if they don't exist
    // These are shared across concurrent library processing
    if (!this.radarrMoviesCache) {
      this.radarrMoviesCache = new Map();
    }
    if (!this.sonarrSeriesCache) {
      this.sonarrSeriesCache = new Map();
    }
    // maintainerrCollectionsCache, collectionMembershipCache and preloadedImdbRatings are initialized on-demand
    // requiredContextFieldsByLibrary is already initialized as a Map
  }

  /**
   * Build a map of item ratingKey → collection IDs for all agregarr and pre-existing collections.
   * Called once at the start of an overlay job for efficient per-item lookups.
   */
  private async buildCollectionMembershipMap(
    plexApi: PlexAPI
  ): Promise<Map<string, string[]>> {
    const membershipMap = new Map<string, string[]>();
    const settings = getSettings();

    // Gather all collections with ratingKeys: agregarr-created + pre-existing
    const collectionsToCheck: { id: string; ratingKey: string }[] = [];

    const agregarrConfigs = settings.plex.collectionConfigs || [];
    for (const config of agregarrConfigs) {
      if (config.collectionRatingKey) {
        collectionsToCheck.push({
          id: config.id,
          ratingKey: config.collectionRatingKey,
        });
      }
    }

    const { preExistingCollectionConfigService } = await import(
      '@server/lib/collections/services/PreExistingCollectionConfigService'
    );
    const preExistingConfigs = preExistingCollectionConfigService.getConfigs();
    for (const config of preExistingConfigs) {
      if (config.collectionRatingKey) {
        collectionsToCheck.push({
          id: config.id,
          ratingKey: config.collectionRatingKey,
        });
      }
    }

    logger.info('Building collection membership map for overlay conditions', {
      label: 'OverlayLibrary',
      totalCollections: collectionsToCheck.length,
    });

    for (const { id, ratingKey } of collectionsToCheck) {
      try {
        const itemRatingKeys = await plexApi.getCollectionItems(ratingKey);
        for (const itemKey of itemRatingKeys) {
          const existing = membershipMap.get(itemKey);
          if (existing) {
            existing.push(id);
          } else {
            membershipMap.set(itemKey, [id]);
          }
        }
      } catch (error) {
        logger.debug('Failed to fetch items for collection', {
          label: 'OverlayLibrary',
          collectionId: id,
          collectionRatingKey: ratingKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('Collection membership map built', {
      label: 'OverlayLibrary',
      collectionsChecked: collectionsToCheck.length,
      itemsWithMembership: membershipMap.size,
    });

    return membershipMap;
  }

  /**
   * Apply overlays to all items in a library
   * Uses mutex-like behavior to prevent concurrent processing of the same library
   */
  async applyOverlaysToLibrary(
    libraryId: string,
    checkCancelled?: () => boolean
  ): Promise<void> {
    // Mutex: wait for any in-progress job to complete before starting
    // Loop to handle multiple waiters waking up simultaneously
    let existing = this.runningLibraries.get(libraryId);
    while (
      existing &&
      (existing.state === 'running' || existing.state === 'cancelling')
    ) {
      logger.warn('Library already being processed, waiting for completion', {
        label: 'OverlayLibrary',
        libraryId,
        libraryName: existing.libraryName,
        state: existing.state,
        startedAt: new Date(existing.startTime).toISOString(),
        runningFor: `${Math.round((Date.now() - existing.startTime) / 1000)}s`,
      });
      // Wait for existing job, catch errors so retries proceed after failures
      await existing._promise.catch(() => undefined);
      // Re-check in case another waiter started a new job
      existing = this.runningLibraries.get(libraryId);
    }

    // Clean up old completed jobs
    this.cleanupCompletedJobs();

    // Create a deferred promise to set in the map immediately
    // This prevents race conditions where two calls pass the check before either awaits
    let resolveDeferred!: () => void;
    let rejectDeferred!: (error: Error) => void;
    const deferredPromise = new Promise<void>((resolve, reject) => {
      resolveDeferred = resolve;
      rejectDeferred = reject;
    });

    // Initialize progress with all fields BEFORE any await (to prevent race condition)
    this.runningLibraries.set(libraryId, {
      libraryName: libraryId, // Will update after config fetch
      startTime: Date.now(),
      state: 'running',
      completedAt: undefined,
      totalItems: 0,
      currentItem: 0,
      currentTitle: '',
      filteredCount: 0,
      successCount: 0,
      errorCount: 0,
      skippedCount: 0,
      _recentItemTimes: [],
      _promise: deferredPromise,
    });

    // Create cancellation checker that includes both external callback and internal set
    const combinedCheckCancelled = () => {
      if (checkCancelled && checkCancelled()) return true;
      return this.cancelledLibraries.has(libraryId);
    };

    try {
      // Get library configuration
      const configRepository = getRepository(OverlayLibraryConfig);
      const config = await configRepository.findOne({
        where: { libraryId },
      });

      // Update libraryName now that we have config
      this.updateProgress(libraryId, (p) => {
        p.libraryName = config?.libraryName || libraryId;
      });

      // Process the library
      await this.processLibraryOverlays(
        libraryId,
        config,
        combinedCheckCancelled
      );

      // Mark completed (stays in map for TTL period)
      // Set completedAt for ANY state to ensure TTL cleanup works
      const progress = this.runningLibraries.get(libraryId);
      if (progress) {
        // If still running, mark completed. If cancelling but finished, mark cancelled.
        if (progress.state === 'running') {
          progress.state = 'completed';
        } else if (progress.state === 'cancelling') {
          progress.state = 'cancelled';
        }
        // Always set completedAt for TTL cleanup
        progress.completedAt = Date.now();
      }
      resolveDeferred();
    } catch (error) {
      // Mark failed
      const progress = this.runningLibraries.get(libraryId);
      if (progress) {
        progress.state = 'failed';
        progress.completedAt = Date.now();
      }
      rejectDeferred(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      // Clean up cancellation flag and per-library state
      this.cancelledLibraries.delete(libraryId);
      this.requiredContextFieldsByLibrary.delete(libraryId);
      // Clear global caches if no other jobs are running (prevents memory leak)
      this.clearGlobalCachesIfIdle();
    }
  }

  /**
   * Internal method to process library overlays
   */
  private async processLibraryOverlays(
    libraryId: string,
    config: OverlayLibraryConfig | null,
    checkCancelled?: () => boolean
  ): Promise<void> {
    try {
      // Initialize caches at start of job (creates if needed, doesn't clear existing)
      this.initializeCachesIfNeeded();

      // Clear TMDB URL cache to avoid stale data from previous runs
      const { plexBasePosterManager } = await import(
        '@server/lib/overlays/PlexBasePosterManager'
      );
      plexBasePosterManager.clearTmdbUrlCache();

      // Also clean up expired TMDB poster files
      await plexBasePosterManager.cleanTmdbCache();

      logger.info('Starting overlay application for library', {
        label: 'OverlayLibrary',
        libraryId,
      });

      if (!config || config.enabledOverlays.length === 0) {
        logger.info('No overlays enabled for library', {
          label: 'OverlayLibrary',
          libraryId,
        });
        return;
      }

      // Get enabled overlay templates
      const templateRepository = getRepository(OverlayTemplate);
      const enabledTemplateIds = config.enabledOverlays
        .filter((o) => o.enabled)
        .map((o) => o.templateId);

      const templates = await templateRepository.findByIds(enabledTemplateIds);

      if (templates.length === 0) {
        logger.info('No templates found for library', {
          label: 'OverlayLibrary',
          libraryId,
        });
        return;
      }

      // Sort templates by layer order
      const sortedTemplates = templates.sort((a, b) => {
        const orderA =
          config.enabledOverlays.find((o) => o.templateId === a.id)
            ?.layerOrder || 0;
        const orderB =
          config.enabledOverlays.find((o) => o.templateId === b.id)
            ?.layerOrder || 0;
        return orderA - orderB;
      });

      // Pre-analyze all enabled templates to determine which context fields are needed
      // This allows skipping expensive API calls (e.g., RT ratings) if no template uses them
      const { extractUsedContextFields } = await import(
        '@server/utils/metadataHashing'
      );
      const templateDataArray = sortedTemplates.map((t) => t.getTemplateData());
      const applicationConditions = sortedTemplates.map((t) =>
        t.getApplicationCondition()
      );
      const requiredContextFields = extractUsedContextFields(
        templateDataArray,
        applicationConditions
      );
      // Store per-library to avoid concurrent library processing overwriting each other's fields
      this.requiredContextFieldsByLibrary.set(libraryId, requiredContextFields);

      // Check which rating fields are needed by templates
      const needsImdbRatings =
        requiredContextFields.has('imdbRating') ||
        requiredContextFields.has('isImdbTop250') ||
        requiredContextFields.has('imdbTop250Rank');

      const needsRtRatings =
        requiredContextFields.has('rtCriticsScore') ||
        requiredContextFields.has('rtAudienceScore');

      logger.info('Applying overlays to library', {
        label: 'OverlayLibrary',
        libraryId,
        templateCount: sortedTemplates.length,
        templates: sortedTemplates.map((t) => t.name),
        requiredFields: Array.from(requiredContextFields),
        needsImdbRatings,
        needsRtRatings,
      });

      // Fetch Maintainerr collections once for the entire job
      const settings = getSettings();
      if (settings.maintainerr?.hostname && settings.maintainerr?.apiKey) {
        try {
          const MaintainerrAPI = (await import('@server/api/maintainerr'))
            .default;
          const maintainerrClient = new MaintainerrAPI(settings.maintainerr);
          this.maintainerrCollectionsCache =
            await maintainerrClient.getCollections();
          logger.info('Fetched Maintainerr collections for overlay job', {
            label: 'OverlayLibrary',
            collectionsCount: this.maintainerrCollectionsCache.length,
          });
        } catch (error) {
          logger.error('Failed to fetch Maintainerr collections', {
            label: 'OverlayLibrary',
            error: error instanceof Error ? error.message : String(error),
          });
          this.maintainerrCollectionsCache = [];
        }
      }

      // Get library items from Plex
      const { getAdminUser } = await import(
        '@server/lib/collections/core/CollectionUtilities'
      );
      const admin = await getAdminUser();

      if (!admin) {
        throw new Error('No admin user found');
      }

      const plexApi = new PlexAPI({ plexToken: admin.plexToken });

      // Build collection membership map for condition evaluation
      // Only build if any enabled template uses a 'collection' condition field
      const hasCollectionConditions = sortedTemplates.some((template) => {
        const condition = template.getApplicationCondition();
        return condition?.sections?.some((s) =>
          s.rules.some((r) => r.field === 'collection')
        );
      });

      if (hasCollectionConditions) {
        this.collectionMembershipCache =
          await this.buildCollectionMembershipMap(plexApi);
      }

      // Fetch all items (handle pagination)
      let allItems: PlexLibraryItem[] = [];
      let offset = 0;
      const pageSize = 50;
      let hasMore = true;

      // Paginate through all library items
      while (hasMore) {
        const response = await plexApi.getLibraryContents(libraryId, {
          offset,
          size: pageSize,
        });

        allItems = allItems.concat(response.items);

        if (offset + pageSize >= response.totalSize) {
          hasMore = false;
        }

        offset += pageSize;
      }

      // Set total items count
      this.updateProgress(libraryId, (p) => {
        p.totalItems = allItems.length;
      });

      logger.info('Processing library items', {
        label: 'OverlayLibrary',
        libraryId,
        itemCount: allItems.length,
      });

      // Handle empty library - mark completed immediately
      if (allItems.length === 0) {
        logger.info('Library has no items to process', {
          label: 'OverlayLibrary',
          libraryId,
        });
        return;
      }

      // ========================================================================
      // PHASE 1: Batch pre-fetch data for performance optimization
      // Only prefetch if templates actually use these fields
      // ========================================================================
      if (needsImdbRatings) {
        await this.prefetchImdbRatings(allItems);
      } else {
        logger.info('Skipping IMDb prefetch - no templates use IMDb ratings', {
          label: 'OverlayLibrary',
          libraryId,
        });
      }

      // Check if any templates need release date info
      const needsReleaseDates =
        requiredContextFields.has('releaseDate') ||
        requiredContextFields.has('daysUntilRelease') ||
        requiredContextFields.has('daysAgo') ||
        requiredContextFields.has('nextEpisodeAirDate') ||
        requiredContextFields.has('daysUntilNextEpisode') ||
        requiredContextFields.has('nextSeasonAirDate') ||
        requiredContextFields.has('daysUntilNextSeason') ||
        requiredContextFields.has('daysAgoNextSeason') ||
        requiredContextFields.has('seasonNumber') ||
        requiredContextFields.has('episodeNumber');

      if (needsReleaseDates) {
        await this.prefetchTmdbReleaseDates(allItems);
      } else {
        logger.info('Skipping TMDB prefetch - no templates use release dates', {
          label: 'OverlayLibrary',
          libraryId,
        });
      }

      // Batch-fetch full metadata for all applicable items in a single Plex call.
      // This replaces N sequential getMetadata() calls (~200ms each) with 1 bulk request.
      const overlayRatingKeys = allItems
        .filter((i) => i.type !== 'episode' && i.type !== 'season')
        .map((i) => i.ratingKey);
      const batchMetadata = await plexApi.getMetadataBatch(overlayRatingKeys);

      // Process each item
      for (const item of allItems) {
        // CRITICAL: Skip episodes and seasons - overlays only apply to movies and shows
        if (item.type === 'episode' || item.type === 'season') {
          this.updateProgress(libraryId, (p) => {
            p.currentItem++; // Advance currentItem to maintain accurate progress %
            p.filteredCount++;
          });
          continue;
        }

        // Check for cancellation FIRST
        if (checkCancelled && checkCancelled()) {
          // Transition to cancelling state
          const progress = this.runningLibraries.get(libraryId);
          if (progress) {
            progress.state = 'cancelling';
          }

          logger.info(
            'Overlay application cancelled during library processing',
            {
              label: 'OverlayLibrary',
              libraryId,
              processedItems: progress?.currentItem || 0,
              totalItems: allItems.length,
            }
          );

          // Mark cancelled (not completed)
          if (progress) {
            progress.state = 'cancelled';
            progress.completedAt = Date.now();
          }
          return; // Exit early, don't continue processing
        }

        // Update current item title (before processing)
        this.updateProgress(libraryId, (p) => {
          p.currentTitle = item.title || '';
        });

        try {
          // Use batch-prefetched metadata, falling back to individual fetch on miss
          const fullMetadata =
            batchMetadata.get(item.ratingKey) ??
            (await plexApi.getMetadata(item.ratingKey));

          // Merge full metadata with library item
          const itemWithFullMetadata = {
            ...item,
            Media: fullMetadata.Media,
            Label: fullMetadata.Label,
          };

          const result = await this.applyOverlaysToItem(
            plexApi,
            itemWithFullMetadata,
            sortedTemplates,
            config.mediaType,
            libraryId,
            config.libraryName
          );

          // Update counts AFTER outcome is known
          this.updateProgress(libraryId, (p) => {
            p.currentItem++;

            // Track timing for ETA
            p._recentItemTimes.push(Date.now());
            if (p._recentItemTimes.length > 20) {
              p._recentItemTimes.shift();
            }

            if (result.skipped) {
              p.skippedCount++;
            } else {
              p.successCount++;
            }
          });
        } catch (error) {
          // Update error count AFTER failure
          this.updateProgress(libraryId, (p) => {
            p.currentItem++;
            p.errorCount++;

            // Track timing for ETA even on errors
            p._recentItemTimes.push(Date.now());
            if (p._recentItemTimes.length > 20) {
              p._recentItemTimes.shift();
            }
          });

          logger.error('Failed to apply overlays to item', {
            label: 'OverlayLibrary',
            itemTitle: item.title,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            errorDetails: error,
          });
          // Continue with next item
        }
      }

      // Get final counts from progress
      const finalProgress = this.runningLibraries.get(libraryId);
      logger.info('Completed overlay application for library', {
        label: 'OverlayLibrary',
        libraryId,
        successCount: finalProgress?.successCount || 0,
        errorCount: finalProgress?.errorCount || 0,
        skippedCount: finalProgress?.skippedCount || 0,
        filteredCount: finalProgress?.filteredCount || 0,
      });
    } catch (error) {
      logger.error('Failed to apply overlays to library', {
        label: 'OverlayLibrary',
        libraryId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    // Note: runningLibraries cleanup is handled by the caller (applyOverlaysToLibrary)
  }

  /**
   * Apply overlays to specific collection items only
   * Used by "Apply overlays during sync" feature
   *
   * @param items - Either an array of rating keys (string[]) or items with context overrides (OverlayItemInput[])
   * @param libraryId - The Plex library ID
   */
  async applyOverlaysToCollectionItems(
    items: string[] | OverlayItemInput[],
    libraryId: string
  ): Promise<void> {
    try {
      // Initialize caches at start of job (creates if needed, doesn't clear existing)
      this.initializeCachesIfNeeded();

      // Normalize input to OverlayItemInput[]
      const normalizedItems: OverlayItemInput[] = items.map((item) =>
        typeof item === 'string' ? { ratingKey: item } : item
      );

      logger.info('Applying overlays to collection items', {
        label: 'OverlayLibrary',
        itemCount: normalizedItems.length,
        libraryId,
      });

      // Get library configuration for templates
      const configRepository = getRepository(OverlayLibraryConfig);
      const config = await configRepository.findOne({
        where: { libraryId },
      });

      // Early return if no overlays configured (same logic as applyOverlaysToLibrary)
      if (!config || config.enabledOverlays.length === 0) {
        logger.info(
          'No overlays enabled for library, skipping overlay application',
          {
            label: 'OverlayLibrary',
            libraryId,
          }
        );
        return;
      }

      // Get enabled overlay templates
      const templateRepository = getRepository(OverlayTemplate);
      const enabledTemplateIds = config.enabledOverlays
        .filter((o) => o.enabled)
        .map((o) => o.templateId);

      const templates = await templateRepository.findByIds(enabledTemplateIds);

      if (templates.length === 0) {
        logger.info(
          'No templates found for library, skipping overlay application',
          {
            label: 'OverlayLibrary',
            libraryId,
          }
        );
        return;
      }

      // Sort templates by layer order
      const sortedTemplates = templates.sort((a, b) => {
        const orderA =
          config.enabledOverlays.find((o) => o.templateId === a.id)
            ?.layerOrder || 0;
        const orderB =
          config.enabledOverlays.find((o) => o.templateId === b.id)
            ?.layerOrder || 0;
        return orderA - orderB;
      });

      // Get admin user for Plex API
      const { getAdminUser } = await import(
        '@server/lib/collections/core/CollectionUtilities'
      );
      const admin = await getAdminUser();

      if (!admin) {
        throw new Error('No admin user found');
      }

      const plexApi = new PlexAPI({ plexToken: admin.plexToken });

      // Build collection membership map if any template uses collection conditions
      const hasCollectionConditions = sortedTemplates.some((template) => {
        const condition = template.getApplicationCondition();
        return condition?.sections?.some((s) =>
          s.rules.some((r) => r.field === 'collection')
        );
      });

      if (hasCollectionConditions) {
        this.collectionMembershipCache =
          await this.buildCollectionMembershipMap(plexApi);
      }

      // Determine media type from library config
      const mediaType = config.mediaType || 'movie';

      // Batch-fetch metadata for all items in a single Plex call
      const itemRatingKeys = normalizedItems.map((i) => i.ratingKey);
      const batchMeta = await plexApi.getMetadataBatch(itemRatingKeys);

      // Process each item
      let successCount = 0;
      let errorCount = 0;

      for (const { ratingKey, contextOverrides } of normalizedItems) {
        try {
          // Use batch-prefetched metadata, falling back to individual fetch on miss
          const itemMetadata =
            batchMeta.get(ratingKey) ?? (await plexApi.getMetadata(ratingKey));

          if (itemMetadata) {
            // CRITICAL: Skip episodes and seasons - overlays only apply to movies and shows
            if (
              itemMetadata.type === 'episode' ||
              itemMetadata.type === 'season'
            ) {
              continue;
            }

            // Convert to PlexLibraryItem format (cast to satisfy type requirements)
            const item = {
              ratingKey: itemMetadata.ratingKey,
              title: itemMetadata.title,
              year: (itemMetadata as { year?: number }).year,
              type: itemMetadata.type,
              guid: itemMetadata.guid || '',
              Guid: itemMetadata.Guid,
              Media: itemMetadata.Media,
              Label: itemMetadata.Label,
              parentIndex: itemMetadata.parentIndex,
              index: itemMetadata.index,
              addedAt: itemMetadata.addedAt || 0,
              updatedAt: itemMetadata.updatedAt || 0,
              editionTitle: (itemMetadata as { editionTitle?: string })
                .editionTitle,
            } as PlexLibraryItem;

            await this.applyOverlaysToItem(
              plexApi,
              item,
              sortedTemplates,
              mediaType,
              libraryId,
              config.libraryName,
              contextOverrides
            );
            successCount++;
          }
        } catch (error) {
          errorCount++;
          logger.error('Failed to apply overlays to collection item', {
            label: 'OverlayLibrary',
            ratingKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      logger.info('Completed overlay application for collection items', {
        label: 'OverlayLibrary',
        successCount,
        errorCount,
        totalItems: normalizedItems.length,
      });
    } catch (error) {
      logger.error('Failed to apply overlays to collection items', {
        label: 'OverlayLibrary',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Apply overlays to a single Plex item
   *
   * NOTE: configuredLibraryType is the library's configured type, but PlexBasePosterManager
   * will use item.type for TMDB API calls to prevent fetching wrong posters
   */
  private async applyOverlaysToItem(
    plexApi: PlexAPI,
    item: PlexLibraryItem,
    templates: OverlayTemplate[],
    configuredLibraryType: 'movie' | 'show',
    libraryId: string,
    libraryName: string,
    contextOverrides?: Partial<OverlayRenderContext>
  ): Promise<OverlayApplyResult> {
    try {
      // CRITICAL: Derive actual media type from item.type, not library config
      // This prevents TMDB API namespace mismatches that cause wrong posters
      const actualMediaType: 'movie' | 'show' =
        item.type === 'movie' ? 'movie' : 'show';

      // Warn if there's a mismatch between item type and library config
      if (actualMediaType !== configuredLibraryType) {
        logger.warn('Item type does not match library configuration', {
          label: 'OverlayLibrary',
          itemTitle: item.title,
          ratingKey: item.ratingKey,
          itemType: item.type,
          configuredLibraryType,
          usingType: actualMediaType,
        });
      }

      // Get metadata tracking for this item
      const metadataService = (
        await import('@server/lib/metadata/MetadataTrackingService')
      ).default;
      const metadata = await metadataService.getItemMetadata(item.ratingKey);

      // Extract TMDB ID from item GUIDs
      let tmdbId: number | undefined;
      if (item.Guid && Array.isArray(item.Guid)) {
        const tmdbGuid = item.Guid.find((g) => g.id?.includes('tmdb://'));
        if (tmdbGuid) {
          const match = tmdbGuid.id.match(/tmdb:\/\/(\d+)/);
          if (match) {
            tmdbId = parseInt(match[1]);
          }
        }
      }

      // Check if this is a placeholder (async version with API call for suspicious items)
      const { placeholderContextService } = await import(
        '@server/lib/placeholders/services/PlaceholderContextService'
      );
      const plexMetadata = item as {
        type: string;
        guid?: string;
        editionTitle?: string;
        Guid?: { id: string }[];
        childCount?: number;
        Children?: { Metadata?: unknown[]; Directory?: unknown[] };
        seasonCount?: number;
        leafCount?: number;
        ratingKey?: string;
      };

      logger.debug('Calling async placeholder detection', {
        label: 'OverlayLibrary',
        itemTitle: item.title,
        ratingKey: item.ratingKey,
        leafCount: plexMetadata.leafCount,
        type: plexMetadata.type,
      });

      const isPlaceholder =
        await placeholderContextService.isPlaceholderItemAsync(
          plexMetadata,
          plexApi['plexClient'] as {
            query: (path: string) => Promise<{
              MediaContainer?: { Directory?: unknown[]; Metadata?: unknown[] };
            }>;
          }
        );

      logger.debug('Async placeholder detection result', {
        label: 'OverlayLibrary',
        itemTitle: item.title,
        ratingKey: item.ratingKey,
        isPlaceholder,
      });

      // Build base context for dynamic fields
      const contextResult = await buildRenderContext(
        item,
        actualMediaType,
        isPlaceholder,
        this.maintainerrCollectionsCache,
        this.preloadedImdbRatings,
        this.requiredContextFieldsByLibrary.get(libraryId)
      );

      // If critical APIs failed (e.g., IMDb timeout), skip this item to avoid
      // regenerating the poster with incomplete data (which would strip overlays)
      if (contextResult.criticalApiFailed) {
        logger.info('Skipping overlay application - critical API failed', {
          label: 'OverlayLibrary',
          itemTitle: item.title,
          ratingKey: item.ratingKey,
        });
        return { skipped: true };
      }

      const baseContext = contextResult.context;

      // Fetch release date information for ALL items with TMDB ID
      // Uses preloaded data from batch prefetch when available
      let releaseDateContext: Partial<OverlayRenderContext> = {};
      if (tmdbId) {
        const releaseDateInfo = await fetchReleaseDateInfo(
          tmdbId,
          actualMediaType,
          this.sonarrSeriesCache,
          this.preloadedTmdbReleaseDates
        );

        if (releaseDateInfo) {
          // Calculate days until release and days ago
          const { calculateDaysSince } = await import(
            '@server/utils/dateHelpers'
          );
          let daysUntilRelease: number | undefined;
          let daysAgo: number | undefined;
          let daysUntilNextEpisode: number | undefined;
          let daysUntilNextSeason: number | undefined;
          let daysAgoNextSeason: number | undefined;

          if (releaseDateInfo.releaseDate) {
            const daysSince = calculateDaysSince(releaseDateInfo.releaseDate);
            if (daysSince < 0) {
              daysUntilRelease = -daysSince;
            } else {
              daysAgo = daysSince;
            }
            logger.debug('Release date calculation', {
              label: 'OverlayLibrary',
              itemTitle: item.title,
              ratingKey: item.ratingKey,
              releaseDate: releaseDateInfo.releaseDate,
              computedDaysAgo: daysAgo,
              computedDaysUntilRelease: daysUntilRelease,
              serverTimezone: process.env.TZ,
              nowUtc: new Date().toISOString(),
            });
          }

          if (releaseDateInfo.nextEpisodeAirDate) {
            const daysSince = calculateDaysSince(
              releaseDateInfo.nextEpisodeAirDate
            );
            if (daysSince < 0) {
              daysUntilNextEpisode = -daysSince;
            }
          }

          if (releaseDateInfo.nextSeasonAirDate) {
            const daysSince = calculateDaysSince(
              releaseDateInfo.nextSeasonAirDate
            );
            if (daysSince < 0) {
              daysUntilNextSeason = -daysSince;
            } else {
              daysAgoNextSeason = daysSince;
            }
          }

          releaseDateContext = {
            releaseDate: releaseDateInfo.releaseDate,
            daysUntilRelease,
            daysAgo,
            nextEpisodeAirDate: releaseDateInfo.nextEpisodeAirDate,
            daysUntilNextEpisode,
            nextSeasonAirDate: releaseDateInfo.nextSeasonAirDate,
            daysUntilNextSeason,
            daysAgoNextSeason,
            seasonNumber: releaseDateInfo.seasonNumber,
            episodeNumber: releaseDateInfo.episodeNumber,
          };
        }
      }

      // Check monitoring status for ALL items with TMDB ID
      let monitoringContext: Partial<OverlayRenderContext> = {};
      if (tmdbId) {
        monitoringContext = await checkMonitoringStatus(
          tmdbId,
          actualMediaType,
          this.radarrMoviesCache,
          this.sonarrSeriesCache
        );
      }

      // Merge contexts: base → release dates → monitoring → explicit overrides
      // Set isPlaceholder and downloaded at the end so they're always present

      // CRITICAL: If *arr reports hasFile=true, the item CANNOT be a placeholder
      // This overrides incorrect placeholder detection (e.g., corrupted metadata)
      let actualIsPlaceholder = isPlaceholder;
      if (monitoringContext.hasFile === true) {
        actualIsPlaceholder = false; // *arr has files, so it's definitely not a placeholder
      }

      // For downloaded: placeholders are never downloaded, real items check *arr hasFile status
      let downloaded: boolean;
      if (actualIsPlaceholder) {
        downloaded = false; // Placeholders are never downloaded
      } else if (typeof monitoringContext.hasFile === 'boolean') {
        downloaded = monitoringContext.hasFile; // Real monitored items use *arr hasFile status
      } else {
        downloaded = true; // Real items not in *arr are assumed downloaded (they exist in Plex)
      }

      // Collection membership for condition evaluation
      const collection = this.collectionMembershipCache?.get(item.ratingKey);

      const context: OverlayRenderContext = {
        ...baseContext,
        isPlaceholder: actualIsPlaceholder,
        downloaded,
        ...contextOverrides,
        ...releaseDateContext,
        ...monitoringContext,
        ...(collection ? { collection } : {}),
      };

      // Filter templates by conditions to get only templates that will actually be applied
      // CRITICAL: Hash must be based on MATCHING templates, not all enabled templates
      // This ensures hash changes when different templates match due to context changes
      const matchingTemplates = templates.filter((template) => {
        const condition = template.getApplicationCondition();
        return evaluateCondition(condition, context);
      });

      // Calculate overlay input hash for metadata tracking
      // Extract which context fields are actually used by MATCHING templates
      // CRITICAL: Hash uses matching template IDs + variable field values + condition field values
      // Template IDs capture which templates match, field values capture all data affecting rendering
      const { calculateOverlayInputHash, extractUsedContextFields } =
        await import('@server/utils/metadataHashing');

      const templateDataArray = matchingTemplates.map((t) =>
        t.getTemplateData()
      );
      const applicationConditions = matchingTemplates.map((t) =>
        t.getApplicationCondition()
      );
      const usedFields = extractUsedContextFields(
        templateDataArray,
        applicationConditions
      );

      const overlayInputHash = calculateOverlayInputHash({
        templateIds: matchingTemplates.map((t) => t.id).sort(),
        templateData: templateDataArray,
        usedFields: usedFields,
        context: context as Record<string, unknown>,
      });

      // Debug logging for hash comparison
      logger.debug('Overlay hash comparison', {
        label: 'OverlayLibrary',
        itemTitle: item.title,
        ratingKey: item.ratingKey,
        oldHash: metadata?.lastOverlayInputHash,
        newHash: overlayInputHash,
        matchingTemplateIds: matchingTemplates.map((t) => t.id).sort(),
        matchingTemplateNames: matchingTemplates.map((t) => t.name),
        usedFields: Array.from(usedFields),
        contextValues: {
          downloaded: context.downloaded,
          hasFile: context.hasFile,
          isMonitored: context.isMonitored,
          inSonarr: context.inSonarr,
          daysAgo: context.daysAgo,
          isPlaceholder: context.isPlaceholder,
        },
      });

      // OPTIMIZATION: Check if overlay inputs changed BEFORE downloading poster
      // This prevents expensive poster downloads when nothing has changed
      try {
        const currentPosterUrl = await plexApi.getCurrentPosterUrl(
          item.ratingKey
        );

        const overlayInputsChanged =
          metadata?.lastOverlayInputHash !== overlayInputHash;

        // Check if Plex poster changed using normalized comparison
        // This handles different URL formats (upload://, /library/metadata/, http://...)
        const { posterUrlsMatch, extractThumbId } = await import(
          '@server/utils/posterUrlHelpers'
        );
        const plexPosterMissing = !posterUrlsMatch(
          metadata?.ourOverlayPosterUrl,
          currentPosterUrl
        );

        // Debug logging for poster URL comparison
        logger.debug('Poster URL comparison', {
          label: 'OverlayLibrary',
          itemTitle: item.title,
          storedUrl: metadata?.ourOverlayPosterUrl,
          currentUrl: currentPosterUrl,
          storedThumbId: extractThumbId(metadata?.ourOverlayPosterUrl),
          currentThumbId: extractThumbId(currentPosterUrl),
          urlsMatch: !plexPosterMissing,
          plexPosterMissing,
        });

        // Also check if base poster source changed (TMDB vs Plex)
        const settings = getSettings();
        const posterSource = settings.overlays?.defaultPosterSource || 'tmdb';
        const basePosterSourceChanged =
          metadata?.basePosterSource !== posterSource;

        if (
          !overlayInputsChanged &&
          !plexPosterMissing &&
          !basePosterSourceChanged
        ) {
          logger.debug('Nothing changed, skipping overlay application', {
            label: 'OverlayLibrary',
            itemTitle: item.title,
            ratingKey: item.ratingKey,
            overlayInputsChanged: false,
            plexPosterMissing: false,
            basePosterSourceChanged: false,
          });
          return { skipped: true }; // Skip this item - no need to download poster
        }

        logger.info('Applying overlays - changes detected', {
          label: 'OverlayLibrary',
          itemTitle: item.title,
          overlayInputsChanged,
          plexPosterMissing,
          basePosterSourceChanged,
        });
      } catch (metaError) {
        logger.warn('Metadata check failed, proceeding with overlay', {
          label: 'MetadataTracking',
          error:
            metaError instanceof Error ? metaError.message : String(metaError),
        });
        // Fall through to apply overlay
      }

      // ONLY download poster if we've determined changes exist
      // Get poster source preference (global setting)
      const settings = getSettings();
      const posterSource = settings.overlays?.defaultPosterSource || 'tmdb';

      // Get base poster with change detection
      const { plexBasePosterManager } = await import(
        '@server/lib/overlays/PlexBasePosterManager'
      );

      let basePosterResult: {
        posterBuffer: Buffer;
        basePosterChanged: boolean;
        sourceUrl: string;
        filename: string;
        fileModTime?: number | null;
      };

      try {
        basePosterResult = await plexBasePosterManager.getBasePosterForOverlay(
          plexApi,
          item,
          libraryId,
          libraryName,
          configuredLibraryType,
          posterSource,
          {
            basePosterSource: metadata?.basePosterSource,
            originalPlexPosterUrl: metadata?.originalPlexPosterUrl,
            ourOverlayPosterUrl: metadata?.ourOverlayPosterUrl,
            basePosterFilename: metadata?.basePosterFilename,
            localPosterModifiedTime: metadata?.localPosterModifiedTime,
          },
          tmdbId
        );
      } catch (error) {
        // Re-throw to let caller track this as a failure
        // Previously this was silently returning, causing failed items to be counted as success
        throw new Error(
          `Failed to get base poster for "${item.title}": ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }

      const posterBuffer = basePosterResult.posterBuffer;

      // Batch render: collect overlay elements from all matching templates,
      // then composite everything in a single sharp operation.
      // This avoids repeated lossy WebP decode/encode cycles between templates.
      let templatesApplied = 0;
      const allOverlays: sharp.OverlayOptions[] = [];

      // Get poster dimensions once (shared across all templates)
      const { width: posterWidth, height: posterHeight } =
        await overlayTemplateRenderer.getPosterDimensions(posterBuffer);

      for (const template of templates) {
        // Check if application condition is met
        const condition = template.getApplicationCondition();
        if (!evaluateCondition(condition, context)) {
          continue;
        }

        const templateData = template.getTemplateData();
        const templateOverlays =
          await overlayTemplateRenderer.renderOverlayElements(
            posterWidth,
            posterHeight,
            templateData,
            context
          );

        if (templateOverlays) {
          allOverlays.push(...templateOverlays);
          templatesApplied++;
        }
      }

      // Single composite + WebP encode for all templates
      const currentBuffer = await overlayTemplateRenderer.compositeOverlays(
        posterBuffer,
        allOverlays
      );

      // Save to temporary file
      const tempDir = os.tmpdir();
      const tempFilePath = path.join(
        tempDir,
        `overlay-${item.ratingKey}-${Date.now()}.webp`
      );

      await fs.writeFile(tempFilePath, currentBuffer);

      try {
        // Upload modified poster back to Plex
        await plexApi.uploadPosterFromFile(item.ratingKey, tempFilePath);

        // Lock poster to prevent Plex from auto-updating it during library scans
        try {
          await plexApi.lockPoster(item.ratingKey);
          logger.debug('Locked poster after overlay application', {
            label: 'OverlayLibrary',
            itemTitle: item.title,
            ratingKey: item.ratingKey,
          });
        } catch (lockError) {
          logger.warn('Failed to lock poster after overlay application', {
            label: 'OverlayLibrary',
            itemTitle: item.title,
            ratingKey: item.ratingKey,
            error:
              lockError instanceof Error
                ? lockError.message
                : String(lockError),
          });
        }

        // Record overlay metadata tracking with base poster info
        try {
          const newPosterUrl = await plexApi.getCurrentPosterUrl(
            item.ratingKey
          );

          if (newPosterUrl) {
            await metadataService.recordOverlayApplicationWithBasePoster(
              item.ratingKey,
              libraryId,
              overlayInputHash,
              newPosterUrl,
              {
                basePosterSource: posterSource,
                originalPlexPosterUrl: basePosterResult.sourceUrl,
                basePosterFilename: basePosterResult.filename,
                localPosterModifiedTime: basePosterResult.fileModTime,
              }
            );
          }
        } catch (metaError) {
          logger.error('Failed to record overlay metadata, upload succeeded', {
            label: 'MetadataTracking',
            error:
              metaError instanceof Error
                ? metaError.message
                : String(metaError),
          });
        }

        // Manage "Overlay" label based on whether overlays were applied
        if (templatesApplied > 0) {
          // Add "Overlay" label to indicate this item has overlays
          try {
            await plexApi.addLabelToItem(item.ratingKey, 'Overlay');
            logger.debug('Added Overlay label', {
              label: 'OverlayLibrary',
              itemTitle: item.title,
              ratingKey: item.ratingKey,
              templatesApplied,
            });
          } catch (error) {
            // Log but don't fail the entire operation if label addition fails
            logger.warn('Failed to add Overlay label', {
              label: 'OverlayLibrary',
              itemTitle: item.title,
              ratingKey: item.ratingKey,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          // Remove "Overlay" label since we've reset to default poster
          try {
            await plexApi.removeLabelFromItem(item.ratingKey, 'Overlay');
            logger.debug('Removed Overlay label - no templates applied', {
              label: 'OverlayLibrary',
              itemTitle: item.title,
              ratingKey: item.ratingKey,
            });
          } catch (error) {
            // Log but don't fail the entire operation if label removal fails
            logger.warn('Failed to remove Overlay label', {
              label: 'OverlayLibrary',
              itemTitle: item.title,
              ratingKey: item.ratingKey,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        logger.info('Applied overlays to item', {
          label: 'OverlayLibrary',
          itemTitle: item.title,
          templateCount: templates.length,
          templatesApplied,
        });

        return { skipped: false };
      } finally {
        // Clean up temp file
        await fs.unlink(tempFilePath).catch(() => {
          // Ignore cleanup errors
        });
      }
    } catch (error) {
      logger.error('Failed to apply overlays to item', {
        label: 'OverlayLibrary',
        itemTitle: item.title,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        errorDetails: error,
      });
      throw error;
    }
  }
}

export const overlayLibraryService = new OverlayLibraryService();

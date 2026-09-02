import ImdbRatingsAPI from '@server/api/imdbRatings';
import type { MaintainerrCollection } from '@server/api/maintainerr';
import type { PlexLibraryItem, PlexMetadata } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import type { RadarrMovie } from '@server/api/servarr/radarr';
import type { SonarrSeries } from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import { getRepository } from '@server/datasource';
import { OverlayLibraryConfig } from '@server/entity/OverlayLibraryConfig';
import type { IconMapping } from '@server/entity/OverlayTemplate';
import { OverlayTemplate } from '@server/entity/OverlayTemplate';
import cacheManager from '@server/lib/cache';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { scrubSecrets } from '@server/utils/logRedaction';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type sharp from 'sharp';
import {
  capTtlForRecentRelease,
  capTtlForUpcomingDate,
  getAdaptiveTtl,
  getNullRatingTtl,
} from './adaptiveTtl';
import type {
  AggregatedMediaInfo,
  EpisodeMediaInfo,
} from './episodeMediaTypes';
import {
  collectSeasonCandidateKeys,
  computeDaysUntilAction,
  seasonFallbackFor,
  type SeasonFallback,
} from './maintainerrCountdown';
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
import { deriveReleaseDateContext } from './releaseDateContext';
import {
  RELEASE_DATE_CONTEXT_FIELDS,
  shouldSkipOnReleaseDateFetchFailure,
} from './releaseDateFetchPolicy';
import { classifySeasonCleanupAction } from './seasonCleanupPolicy';
import { restoreSeasonBasePoster } from './seasonPosterRestore';

/**
 * Resolve the base poster source for an item.
 *
 * Seasons always use Plex. Their Plex guid carries a TMDB id in TMDB's *season*
 * namespace, which resolves to an unrelated show on the endpoints the TMDB and
 * local sources call, so those sources are structurally unreachable for a season.
 * Both read sites in `applyOverlaysToItem` go through here so the value written to
 * `basePosterSource` matches the one the `basePosterSourceChanged` gate compares
 * against - otherwise every run would see a changed source and re-upload.
 */
function resolveBasePosterSource(
  itemType: PlexLibraryItem['type'],
  settings: ReturnType<typeof getSettings>
): 'tmdb' | 'plex' | 'local' {
  return itemType === 'season'
    ? 'plex'
    : settings.overlays?.defaultPosterSource || 'tmdb';
}

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

  // Per-item error details for persistence (capped at 50 per library)
  itemErrors: { title: string; ratingKey: string; error: string }[];

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
  itemErrors?: { title: string; ratingKey: string; error: string }[];
}

/**
 * Result from applying overlays to a single item
 */
interface OverlayApplyResult {
  skipped: boolean; // true if nothing changed (hash match)
}

/**
 * Job-local result of fetching Maintainerr collections. `unavailable` covers a
 * failed or unconfigured Maintainerr connection, or a response missing usable
 * media arrays (e.g. the <3.4.0 fallback endpoint). Callers must NOT treat it as
 * "zero collections" — that would erase every item's deletion countdown.
 */
type MaintainerrFetchResult =
  | { status: 'ok'; collections: MaintainerrCollection[] }
  | { status: 'unavailable' };

/**
 * Outcome of the Maintainerr season subpass. This is the contract the cleanup pass
 * reads before restoring posters and deleting rows, so every field is stated in
 * terms of what it authorises.
 */
interface SeasonSubpassResult {
  /** Season ratingKeys that still have a live deletion countdown in this library. */
  activeSeasonKeys: Set<string>;
  /**
   * True only when every candidate season key reached a definite answer: found in
   * Plex, or a confirmed 404. False when any key ended ambiguous, when Maintainerr
   * was unavailable, or when Maintainerr tracked a season it did not identify.
   *
   * Deliberately WHOLE-JOB scoped, not per-library: candidate keys are drawn from
   * every Maintainerr season collection, which may span several Plex libraries, and
   * a key that fails to resolve cannot be attributed to a library. So an ambiguous
   * key belonging to library B also blocks library A's cleanup. That is the safe
   * direction (a blocked cleanup retries next run; a wrong one destroys posters),
   * but do not read this flag as "this library resolved cleanly".
   */
  resolutionComplete: boolean;
  /**
   * True when the job was cancelled partway through the subpass. Cleanup must check
   * this before `resolutionComplete`: resolution can complete and the job still be
   * cancelled before every active season was processed, which leaves the active set
   * accurate but the run incomplete.
   */
  cancelled: boolean;
}

/**
 * Service for applying overlay templates to Plex library items
 */
class OverlayLibraryService {
  // Cache for Radarr/Sonarr library data (global, keyed by instance URL)
  // These are shared across libraries since Radarr/Sonarr data is the same regardless of Plex library
  private radarrMoviesCache?: Map<string, RadarrMovie[]>;
  private sonarrSeriesCache?: Map<string, SonarrSeries[]>;
  // Maps item ratingKey → array of collection IDs the item belongs to
  private collectionMembershipCache?: Map<string, string[]>;

  // Aggregated episode media info for show libraries (per-library, keyed by show ratingKey)
  private aggregatedMediaByLibrary = new Map<
    string,
    Map<string, AggregatedMediaInfo>
  >();

  // Memoised episode aggregation for the collection / quick-sync overlay path,
  // keyed by libraryId. Deduplicates the many per-collection calls in one sync
  // cycle so they don't each re-query and re-aggregate the whole library.
  // Invalidated in runEpisodeScan (the sole writer of the episode media cache)
  // for immediate freshness after a scan, and bounded by a short TTL so it can
  // never outlive the underlying cache's own 7-day freshness window.
  private aggregatedMediaCacheMemo = new Map<
    string,
    { at: number; aggregated: Map<string, AggregatedMediaInfo> | undefined }
  >();

  // Short enough to always be fresher than the 7-day episode cache TTL, long
  // enough to cover one sync cycle's worth of per-collection calls.
  private static readonly AGGREGATION_MEMO_TTL_MS = 10 * 60 * 1000;

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

  // Snapshot of last-completed job results per library (survives TTL cleanup)
  private lastCompletedLibraries = new Map<
    string,
    LibraryStatus & { libraryId: string }
  >();

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

  private snapshotLastCompleted(
    libraryId: string,
    progress: LibraryProgress
  ): void {
    const runningFor = Math.round(
      ((progress.completedAt ?? Date.now()) - progress.startTime) / 1000
    );
    this.lastCompletedLibraries.set(libraryId, {
      libraryId,
      running: false,
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
      progressPercent:
        progress.totalItems > 0
          ? Math.min(
              100,
              Math.round((progress.currentItem / progress.totalItems) * 100)
            )
          : 100,
      estimatedSecondsRemaining: null,
      itemErrors:
        progress.itemErrors.length > 0 ? [...progress.itemErrors] : undefined,
    });
  }

  public getLastCompletedLibraries(): (LibraryStatus & {
    libraryId: string;
  })[] {
    return Array.from(this.lastCompletedLibraries.values());
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
        ].filter(Boolean),
      });
      this.radarrMoviesCache = undefined;
      this.sonarrSeriesCache = undefined;
      this.preloadedImdbRatings = undefined;
      this.preloadedTmdbReleaseDates = undefined;
    }
  }

  /**
   * Fetch Maintainerr collections for one overlay job as a discriminated result.
   * Returns `unavailable` (never an empty list masquerading as success) when
   * Maintainerr isn't configured, the request fails, or the response is missing
   * usable media arrays — so downstream code can tell "no collections" apart from
   * "couldn't reach Maintainerr" and never wipe a countdown on a transient error.
   */
  private async fetchMaintainerrCollections(
    settings: ReturnType<typeof getSettings>
  ): Promise<MaintainerrFetchResult> {
    const maintainerr = settings.maintainerr;
    if (!maintainerr?.hostname || !maintainerr?.apiKey) {
      logger.debug('Maintainerr not configured; skipping collection fetch', {
        label: 'OverlayLibrary',
      });
      return { status: 'unavailable' };
    }

    try {
      const MaintainerrAPI = (await import('@server/api/maintainerr')).default;
      const maintainerrClient = new MaintainerrAPI(maintainerr);
      const collections = await maintainerrClient.getCollections();

      // The <3.4.0 fallback endpoint (/api/collections) can omit `media`. A
      // collection without a media array can't be joined by ratingKey, so treat
      // any such response as unavailable rather than dropping every countdown.
      if (
        !Array.isArray(collections) ||
        collections.some((c) => !Array.isArray(c.media))
      ) {
        logger.warn(
          'Maintainerr response missing media arrays; treating as unavailable',
          { label: 'OverlayLibrary' }
        );
        return { status: 'unavailable' };
      }

      logger.info('Fetched Maintainerr collections for overlay job', {
        label: 'OverlayLibrary',
        collectionsCount: collections.length,
      });
      return { status: 'ok', collections };
    } catch (error) {
      logger.error('Failed to fetch Maintainerr collections', {
        label: 'OverlayLibrary',
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: 'unavailable' };
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

      // Release dates are region-preferred, so region is part of the persistent
      // cache key: a change to watchProviderRegion (or a deploy that changes the
      // extraction logic) must not be masked by entries keyed without it. The
      // in-memory preload map stays keyed `${tmdbId}:${mediaType}` to match the
      // lookup in fetchReleaseDateInfo.
      const region = getSettings().overlays?.watchProviderRegion || 'US';

      // Check cache for existing entries
      const uncachedItems: typeof tmdbItems = [];
      let cacheHits = 0;
      let nullCacheHits = 0;

      for (const item of tmdbItems) {
        const mapKey = `${item.tmdbId}:${item.mediaType}`;
        const cacheKey = `${mapKey}:${region}`;
        const cached = adaptiveCache.get<ReleaseDateInfo | null>(cacheKey);

        if (cached !== undefined) {
          this.preloadedTmdbReleaseDates.set(mapKey, cached);
          logger.debug('Prefetch: cache HIT', {
            label: 'OverlayLibrary',
            cacheKey,
            releaseDate: cached?.releaseDate ?? 'null',
            // fork#35: surface the time-sensitive dates so a stale next-episode
            // entry is greppable in the logs, not just a code read.
            nextEpisodeAirDate: cached?.nextEpisodeAirDate ?? 'none',
            nextSeasonAirDate: cached?.nextSeasonAirDate ?? 'none',
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
            const mapKey = `${tmdbId}:${mediaType}`;
            const cacheKey = `${mapKey}:${region}`;
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
                    movieDetails.release_dates.results,
                    region
                  );
                  const determined = determineReleaseDate(
                    extracted.digitalRelease,
                    extracted.physicalRelease,
                    extracted.inCinemas
                  );
                  if (determined) {
                    releaseDateInfo = {
                      releaseDate: determined.releaseDate,
                      isEstimated: determined.isEstimated,
                    };
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
                  releaseDateInfo = {
                    releaseDate: movieDetails.release_date,
                    isEstimated: false,
                  };
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
                    tvdbId: showDetails.external_ids?.tvdb_id,
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
              let ttl = capTtlForRecentRelease(
                releaseDateInfo?.releaseDate,
                baseTtl
              );
              // fork#35: the adaptive TTL is keyed on the show's release YEAR, but
              // the value cached here is the next episode air date. Cap the TTL so
              // the entry cannot outlive that date and serve a stale (undefined)
              // daysUntilNextEpisode. nextSeasonAirDate, when present, equals
              // nextEpisodeAirDate (season premiere), so this covers both.
              if (releaseDateInfo?.nextEpisodeAirDate) {
                ttl = capTtlForUpcomingDate(
                  releaseDateInfo.nextEpisodeAirDate,
                  ttl
                );
              }
              if (releaseDateInfo) {
                preloadedMap?.set(mapKey, releaseDateInfo);
                adaptiveCache.set(cacheKey, releaseDateInfo, ttl);
                fetchSuccess++;
              } else {
                // For movies without release dates, cache null
                const nullTtl = getNullRatingTtl(year);
                preloadedMap?.set(mapKey, null);
                adaptiveCache.set(cacheKey, null, nullTtl);
              }
            } catch (error) {
              fetchFailures++;
              // fork#35: a thrown fetch is NOT an authoritative "no release date"
              // - caching it as null (for either media type) strips a date
              // overlay until the null TTL expires AND makes the per-item path
              // return a preloaded null without setting fetchStatus.failed, so
              // the Mechanism-2 skip-guard is bypassed. Leave the item uncached
              // so the per-item live fetch runs and can set failed -> skip.
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
    // collectionMembershipCache and preloadedImdbRatings are initialized on-demand
    // (Maintainerr collections are fetched job-locally, not cached on the instance)
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
      itemErrors: [],
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
        this.snapshotLastCompleted(libraryId, progress);
      }
      resolveDeferred();
    } catch (error) {
      // Mark failed
      const progress = this.runningLibraries.get(libraryId);
      if (progress) {
        progress.state = 'failed';
        progress.completedAt = Date.now();
        this.snapshotLastCompleted(libraryId, progress);
      }
      rejectDeferred(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      // Clean up cancellation flag and per-library state
      this.cancelledLibraries.delete(libraryId);
      this.requiredContextFieldsByLibrary.delete(libraryId);
      this.aggregatedMediaByLibrary.delete(libraryId);
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

      // Season cleanup has to run from the config-driven early returns below,
      // which are reached before the Plex client used to exist. Resolving it
      // lazily hoists it without cost: a library with no config and no tracked
      // seasons does zero Plex work and never builds a client. A library that
      // DOES have departed season rows will build one, so 'No admin user found'
      // becomes reachable from those branches - correctly, since there is then
      // real Plex work to do, and the throw happens before any deletion.
      let plexApiInstance: PlexAPI | undefined;
      const getPlexApi = async (): Promise<PlexAPI> => {
        if (!plexApiInstance) {
          const { getAdminUser } = await import(
            '@server/lib/collections/core/CollectionUtilities'
          );
          const admin = await getAdminUser();

          if (!admin) {
            throw new Error('No admin user found');
          }

          plexApiInstance = new PlexAPI({ plexToken: admin.plexToken });
        }

        return plexApiInstance;
      };

      if (!config) {
        logger.info('No overlay configuration for library', {
          label: 'OverlayLibrary',
          libraryId,
        });

        // Deleting the config row does not delete the season rows keyed to this
        // library, and nothing else ever visits them - so without this the
        // countdown poster would stay on Plex forever. `config` comes from a
        // findOne, which returns null only for a confirmed absent row, so this is
        // configuration, not a data read that could hiccup.
        await this.cleanupDepartedSeasonOverlays(
          getPlexApi,
          libraryId,
          new Set(),
          checkCancelled
        );
        return;
      }

      if (config.enabledOverlays.length === 0) {
        logger.info('No overlays enabled for library', {
          label: 'OverlayLibrary',
          libraryId,
        });

        // Configuration, not a data read: the user turned overlays off, so every
        // season we still overlay has departed by definition.
        await this.cleanupDepartedSeasonOverlays(
          getPlexApi,
          libraryId,
          new Set(),
          checkCancelled
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
        logger.info('No templates found for library', {
          label: 'OverlayLibrary',
          libraryId,
        });

        // Gate cleanup on the config JSON, never on the query result. An empty
        // enabledTemplateIds is the user disabling every overlay. An empty
        // findByIds against a non-empty id list is a transient DB read, and
        // restoring every season poster on the strength of one is not undoable.
        if (enabledTemplateIds.length === 0) {
          await this.cleanupDepartedSeasonOverlays(
            getPlexApi,
            libraryId,
            new Set(),
            checkCancelled
          );
        } else {
          logger.warn(
            'Enabled templates missing from database - skipping season cleanup',
            {
              label: 'OverlayLibrary',
              libraryId,
              enabledTemplateIds,
            }
          );
        }
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

      // Fetch Maintainerr collections once for the entire job. Kept job-local (a
      // local var, not an instance field) so concurrent library jobs can't read
      // each other's collections. `unavailable` is distinct from an empty list.
      const settings = getSettings();
      const maintainerrResult = await this.fetchMaintainerrCollections(
        settings
      );
      const maintainerrCollections =
        maintainerrResult.status === 'ok'
          ? maintainerrResult.collections
          : undefined;

      // Get library items from Plex
      const plexApi = await getPlexApi();

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
        // Deliberately no season cleanup here. This is a *data* read, and a Plex
        // hiccup that returns an empty listing is indistinguishable from a truly
        // empty library - restoring every tracked season poster off the back of
        // one would be a mass, unrecoverable write.
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
      const needsReleaseDates = RELEASE_DATE_CONTEXT_FIELDS.some((field) =>
        requiredContextFields.has(field)
      );

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

      // Episode media scanning: aggregate episode-level resolution/HDR/DV to show posters
      if (config.enableEpisodeScanning && config.mediaType === 'show') {
        await this.runEpisodeScan(plexApi, libraryId, requiredContextFields);
      }

      // Process each item (concurrency-limited)
      const rawConcurrency = Number(getSettings().overlays?.overlayConcurrency);
      const concurrency =
        Number.isFinite(rawConcurrency) && rawConcurrency >= 1
          ? Math.min(10, Math.floor(rawConcurrency))
          : 1;
      let cancelled = false;

      const processItem = async (item: PlexLibraryItem) => {
        if (item.type === 'episode' || item.type === 'season') {
          this.updateProgress(libraryId, (p) => {
            p.currentItem++;
            p.filteredCount++;
          });
          return;
        }

        this.updateProgress(libraryId, (p) => {
          p.currentTitle = item.title || '';
        });

        try {
          const fullMetadata =
            batchMetadata.get(item.ratingKey) ??
            (await plexApi.getMetadata(item.ratingKey));

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
            config.libraryName,
            maintainerrCollections,
            seasonFallbackFor(config)
          );

          this.updateProgress(libraryId, (p) => {
            p.currentItem++;
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
          this.updateProgress(libraryId, (p) => {
            p.currentItem++;
            p.errorCount++;
            if (p.itemErrors.length < 50) {
              const raw =
                error instanceof Error ? error.message : String(error);
              p.itemErrors.push({
                title: item.title || 'Unknown',
                ratingKey: item.ratingKey,
                error: scrubSecrets(raw).slice(0, 200),
              });
            }
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
        }
      };

      const active: Promise<void>[] = [];
      try {
        for (const item of allItems) {
          if (checkCancelled?.()) {
            cancelled = true;
            break;
          }
          const p = processItem(item).finally(() => {
            active.splice(active.indexOf(p), 1);
          });
          active.push(p);
          if (active.length >= concurrency) {
            await Promise.race(active);
          }
        }
      } finally {
        await Promise.allSettled(active);
      }

      if (cancelled) {
        const progress = this.runningLibraries.get(libraryId);
        if (progress) {
          progress.state = 'cancelling';
        }
        logger.info('Overlay application cancelled during library processing', {
          label: 'OverlayLibrary',
          libraryId,
          processedItems: progress?.currentItem || 0,
          totalItems: allItems.length,
        });
        if (progress) {
          progress.state = 'cancelled';
          progress.completedAt = Date.now();
        }
        return;
      }

      // Seasons never appear in the library listing above; Maintainerr nominates
      // them by ratingKey. Opt-in, show libraries only.
      if (
        config.mediaType === 'show' &&
        config.enableMaintainerrSeasonOverlays
      ) {
        const seasonResult = await this.applyMaintainerrSeasonOverlays(
          plexApi,
          libraryId,
          config,
          sortedTemplates,
          maintainerrResult,
          checkCancelled
        );

        // Cancellation is checked BEFORE resolutionComplete: a run can resolve
        // every candidate key and still be cancelled before it processed each
        // active season, which leaves the active set accurate but the run
        // incomplete. Cleaning up from there is a write we never asked for.
        if (seasonResult.cancelled) {
          return; // Cancellation state already recorded by the subpass
        }

        if (seasonResult.resolutionComplete) {
          await this.cleanupDepartedSeasonOverlays(
            getPlexApi,
            libraryId,
            seasonResult.activeSeasonKeys,
            checkCancelled
          );
        } else {
          logger.info(
            'Skipping season overlay cleanup - season resolution was incomplete',
            {
              label: 'MaintainerrSeasonOverlay',
              libraryId,
              activeSeasons: seasonResult.activeSeasonKeys.size,
            }
          );
        }
      } else {
        // The toggle is off (or this is not a show library), which is a
        // deterministic statement of intent: restore anything we still track.
        await this.cleanupDepartedSeasonOverlays(
          getPlexApi,
          libraryId,
          new Set(),
          checkCancelled
        );
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

      // Convert batch metadata to PlexLibraryItem[] for prefetch
      const plexItems: PlexLibraryItem[] = [];
      for (const meta of batchMeta.values()) {
        if (meta && meta.type !== 'episode' && meta.type !== 'season') {
          plexItems.push({
            ratingKey: meta.ratingKey,
            title: meta.title,
            year: (meta as { year?: number }).year,
            type: meta.type,
            guid: meta.guid || '',
            Guid: meta.Guid,
            Media: meta.Media,
            Label: meta.Label,
            parentIndex: meta.parentIndex,
            index: meta.index,
            addedAt: meta.addedAt || 0,
            updatedAt: meta.updatedAt || 0,
            editionTitle: (meta as { editionTitle?: string }).editionTitle,
          } as PlexLibraryItem);
        }
      }

      // Prefetch IMDb ratings and TMDB release dates for collection items
      // (mirrors the library-level prefetch in applyOverlaysToLibrary)
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
      this.requiredContextFieldsByLibrary.set(libraryId, requiredContextFields);

      try {
        const needsImdbRatings =
          requiredContextFields.has('imdbRating') ||
          requiredContextFields.has('isImdbTop250') ||
          requiredContextFields.has('imdbTop250Rank');

        const needsReleaseDates = RELEASE_DATE_CONTEXT_FIELDS.some((field) =>
          requiredContextFields.has(field)
        );

        if (needsImdbRatings && plexItems.length > 0) {
          await this.prefetchImdbRatings(plexItems);
        }
        if (needsReleaseDates && plexItems.length > 0) {
          await this.prefetchTmdbReleaseDates(plexItems);
        }

        // Load episode-derived quality data (resolution/HDR/DV) for show
        // libraries from the persisted episode-media cache so background and
        // collection syncs keep quality badges. runEpisodeScan is the
        // authoritative writer; here we only read it (memoised per library, no
        // Plex calls). See getAggregatedMediaFromCache for the trade-offs.
        const aggregatedMedia =
          config.enableEpisodeScanning && mediaType === 'show'
            ? await this.getAggregatedMediaFromCache(libraryId)
            : undefined;

        // Process each item
        let successCount = 0;
        let errorCount = 0;

        for (const { ratingKey, contextOverrides } of normalizedItems) {
          try {
            // Use batch-prefetched metadata, falling back to individual fetch on miss
            const itemMetadata =
              batchMeta.get(ratingKey) ??
              (await plexApi.getMetadata(ratingKey));

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
                // This path never fetches Maintainerr collections; passing
                // undefined removes the old cross-job contamination where it
                // read whatever a concurrent library job left in the shared cache.
                undefined,
                // Moot without collections, but kept honest to the config.
                seasonFallbackFor(config),
                contextOverrides,
                aggregatedMedia
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
      } finally {
        this.requiredContextFieldsByLibrary.delete(libraryId);
      }
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
   *
   * @param seasonFallback - Whether a show with no Maintainerr schedule of its own
   *   may inherit one from its seasons, and which season's date it takes. Derived
   *   from the library config by every caller (see `seasonFallbackFor`) so the
   *   "Show poster countdown" setting reaches the countdown by one route;
   *   NO_SEASON_FALLBACK is the safe value for a caller with no config to hand.
   * @param requireOverlayMatch - When true, an item whose conditions match no
   *   template is skipped before any poster work. Callers that visit items only
   *   because an external source nominated them (the Maintainerr season subpass)
   *   must set this: without it a condition-miss still re-encodes, re-uploads and
   *   locks the poster with no visible overlay. Existing callers omit it and keep
   *   today's behaviour, where a zero-match item resets to its base poster.
   */
  private async applyOverlaysToItem(
    plexApi: PlexAPI,
    item: PlexLibraryItem,
    templates: OverlayTemplate[],
    configuredLibraryType: 'movie' | 'show',
    libraryId: string,
    libraryName: string,
    maintainerrCollections: MaintainerrCollection[] | undefined,
    seasonFallback: SeasonFallback,
    contextOverrides?: Partial<OverlayRenderContext>,
    aggregatedMediaOverride?: Map<string, AggregatedMediaInfo>,
    requireOverlayMatch?: boolean
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
        maintainerrCollections,
        this.preloadedImdbRatings,
        this.requiredContextFieldsByLibrary.get(libraryId),
        seasonFallback
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
        const releaseDateFetch = { failed: false };
        const releaseDateInfo = await fetchReleaseDateInfo(
          tmdbId,
          actualMediaType,
          this.sonarrSeriesCache,
          this.preloadedTmdbReleaseDates,
          releaseDateFetch
        );

        // fork#35 (Mechanism 2): a transient TMDB/Sonarr failure returns
        // undefined the same as "no upcoming date exists". If this library's
        // overlays actually depend on a release-date field, skip the item rather
        // than re-render without it and strip a date-driven overlay - mirroring
        // the criticalApiFailed IMDb guard above. Scoped to required fields so a
        // genuinely date-less show still clears and unrelated poster/quality
        // updates are not blocked by an unrelated date-API blip.
        if (
          releaseDateFetch.failed &&
          shouldSkipOnReleaseDateFetchFailure(
            this.requiredContextFieldsByLibrary.get(libraryId)
          )
        ) {
          logger.info(
            'Skipping overlay application - release date fetch failed',
            {
              label: 'OverlayLibrary',
              itemTitle: item.title,
              ratingKey: item.ratingKey,
            }
          );
          return { skipped: true };
        }

        if (releaseDateInfo) {
          // Shared read-time derivation: clears a next-episode countdown whose
          // date has already passed (fork#35), used identically here and by the
          // overlay-test route so the two cannot diverge.
          releaseDateContext = deriveReleaseDateContext(releaseDateInfo);
          logger.debug('Release date calculation', {
            label: 'OverlayLibrary',
            itemTitle: item.title,
            ratingKey: item.ratingKey,
            releaseDate: releaseDateInfo.releaseDate,
            computedDaysAgo: releaseDateContext.daysAgo,
            computedDaysUntilRelease: releaseDateContext.daysUntilRelease,
            computedDaysUntilNextEpisode:
              releaseDateContext.daysUntilNextEpisode,
            nextEpisodeAirDate: releaseDateContext.nextEpisodeAirDate,
            serverTimezone: process.env.TZ,
            nowUtc: new Date().toISOString(),
          });
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

      // Merge aggregated episode media info if available for this show
      let episodeAggregation: Partial<OverlayRenderContext> = {};
      const aggregatedMap =
        aggregatedMediaOverride ?? this.aggregatedMediaByLibrary.get(libraryId);
      if (item.type === 'show') {
        episodeAggregation.episodeMediaSource = 'show';
      }
      if (aggregatedMap && item.type === 'show') {
        const agg = aggregatedMap.get(item.ratingKey);
        if (agg) {
          episodeAggregation = {
            showResolution: baseContext.resolution,
            showHdr: baseContext.hdr,
            showDolbyVision: baseContext.dolbyVision,
            showDolbyVisionProfile: baseContext.dolbyVisionProfile,
            showAudioCodec: baseContext.audioCodec,
            showAudioChannels: baseContext.audioChannels,
            showVideoCodec: baseContext.videoCodec,
            showBitDepth: baseContext.bitDepth,
            resolution: agg.resolution,
            hdr: agg.hdr,
            dolbyVision: agg.dolbyVision,
            dolbyVisionProfile: agg.dolbyVisionProfile,
            videoCodec: agg.videoCodec,
            audioCodec: agg.audioCodec,
            audioChannels: agg.audioChannels,
            bitDepth: agg.bitDepth,
            episodeCount: agg.episodeCount,
            episode4kCount: agg.episode4kCount,
            episode4kPercent: agg.episode4kPercent,
            episodeHdrCount: agg.episodeHdrCount,
            episodeHdrPercent: agg.episodeHdrPercent,
            episodeDvCount: agg.episodeDvCount,
            episodeDvPercent: agg.episodeDvPercent,
            episodeMediaSource: 'aggregated',
          };
        }
      }

      // Collection membership for condition evaluation
      const collection = this.collectionMembershipCache?.get(item.ratingKey);

      const context: OverlayRenderContext = {
        ...baseContext,
        isPlaceholder: actualIsPlaceholder,
        downloaded,
        ...episodeAggregation,
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

      // Nominated-item callers bail out here: no matching template means there is
      // nothing to draw, and everything below (hash, base poster, upload, lock)
      // would rewrite the poster for no visible gain.
      if (requireOverlayMatch && matchingTemplates.length === 0) {
        logger.debug('No template conditions matched, skipping item', {
          label: 'OverlayLibrary',
          itemTitle: item.title,
          ratingKey: item.ratingKey,
          itemType: item.type,
        });
        return { skipped: true };
      }

      // Calculate overlay input hash for metadata tracking
      // Extract which context fields are actually used by MATCHING templates
      // CRITICAL: Hash uses matching template IDs + variable field values + condition field values
      // Template IDs capture which templates match, field values capture all data affecting rendering
      const {
        calculateOverlayInputHash,
        extractUsedContextFields,
        extractMappedIconFields,
      } = await import('@server/utils/metadataHashing');

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

      // Fold effective (user-override-aware) icon mappings for fields matching
      // mapped-icon elements read, so a mapping edit invalidates the hash even
      // though the mapping itself lives outside templateData. getMergedMappings
      // shares UserMappingsService's mtime-guarded cache with the renderer, so
      // this reads the same snapshot the render below will use.
      const mappedIconFields = extractMappedIconFields(templateDataArray);
      let mappedIconMappings: Record<string, IconMapping[]> | undefined;
      if (mappedIconFields.size > 0) {
        const { getMergedMappings } = await import(
          '@server/lib/overlays/UserMappingsService'
        );
        mappedIconMappings = {};
        for (const field of mappedIconFields) {
          mappedIconMappings[field] = getMergedMappings(field);
        }
      }

      const overlayInputHash = calculateOverlayInputHash({
        templateIds: matchingTemplates.map((t) => t.id).sort(),
        templateData: templateDataArray,
        usedFields: usedFields,
        context: context as Record<string, unknown>,
        mappedIconMappings,
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
          // fork#35: the fields behind next-episode/next-season overlays, so a
          // dropped date overlay is diagnosable from this line alone.
          nextEpisodeAirDate: context.nextEpisodeAirDate,
          daysUntilNextEpisode: context.daysUntilNextEpisode,
          nextSeasonAirDate: context.nextSeasonAirDate,
          daysUntilNextSeason: context.daysUntilNextSeason,
        },
      });

      // Whether the CURRENT Plex poster is the one we last uploaded. Used
      // after the render loop below to tell "nothing to remove" (skip the
      // upload) from "overlays need to come off" (fall through to the
      // existing removal-by-reupload path) when a run renders zero overlay
      // elements. Defaults to true (favor the pre-fix upload path, not a
      // skip) if the check below throws before it runs - the catch below
      // exists to fall through to the overlay flow on a transient failure,
      // and a stale-overlay-left-in-place outcome must not become the
      // default on that path.
      let currentPosterIsOurs = true;

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
        currentPosterIsOurs = !plexPosterMissing;

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
        const posterSource = resolveBasePosterSource(item.type, settings);
        const basePosterSourceChanged =
          metadata?.basePosterSource !== posterSource;

        // For local poster source, stat the local poster file so a new or
        // updated poster.jpg is picked up even when nothing else changed.
        // Cheap check (directory listing + stat) - no download, no file read.
        let localPosterChanged = false;
        if (posterSource === 'local' && tmdbId) {
          const { plexBasePosterManager } = await import(
            '@server/lib/overlays/PlexBasePosterManager'
          );
          localPosterChanged =
            await plexBasePosterManager.hasLocalPosterChanged(
              libraryId,
              libraryName,
              item.title,
              item.year,
              tmdbId,
              metadata?.localPosterModifiedTime
            );
        }

        if (
          !overlayInputsChanged &&
          !plexPosterMissing &&
          !basePosterSourceChanged &&
          !localPosterChanged
        ) {
          logger.debug('Nothing changed, skipping overlay application', {
            label: 'OverlayLibrary',
            itemTitle: item.title,
            ratingKey: item.ratingKey,
            overlayInputsChanged: false,
            plexPosterMissing: false,
            basePosterSourceChanged: false,
            localPosterChanged: false,
          });
          return { skipped: true }; // Skip this item - no need to download poster
        }

        logger.info('Applying overlays - changes detected', {
          label: 'OverlayLibrary',
          itemTitle: item.title,
          overlayInputsChanged,
          plexPosterMissing,
          basePosterSourceChanged,
          localPosterChanged,
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
      const posterSource = resolveBasePosterSource(item.type, settings);

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

        if (templateOverlays?.length) {
          allOverlays.push(...templateOverlays);
          templatesApplied++;
        }
      }

      if (allOverlays.length === 0 && !currentPosterIsOurs) {
        // No overlay elements rendered, and the current Plex poster isn't one
        // we uploaded - nothing to draw and nothing of ours to remove.
        // Compositing now would only produce a lossy re-encode of a poster we
        // never touched. No bookkeeping to write here: the ownership
        // mismatch that got us into this branch is exactly what the "nothing
        // changed" gate above re-checks every run (its !plexPosterMissing
        // requirement), so no input-hash write could ever short-circuit it -
        // this item re-renders and re-skips each run. Cheap relative to the
        // upload it replaces; a negative cache is a separate change if it's
        // ever worth it.
        logger.info('No overlay elements rendered - skipping upload', {
          label: 'OverlayLibrary',
          itemTitle: item.title,
          ratingKey: item.ratingKey,
          matchingTemplates: matchingTemplates.length,
        });

        return { skipped: true };
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
              },
              // Raw item.type on purpose - NOT actualMediaType. itemType must
              // preserve the exact Plex kind ('movie' | 'show' | 'season') for
              // the season cleanup lifecycle's exact-match query;
              // actualMediaType deliberately collapses 'season' -> 'show' for
              // TMDB namespace resolution and would erase that distinction.
              item.type
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

  /**
   * Apply deletion-countdown overlays to the seasons Maintainerr has scheduled for
   * deletion.
   *
   * Plex's own library listing never surfaces seasons, so the main loop cannot see
   * them. Maintainerr nominates them by ratingKey instead, which makes this a
   * subpass rather than part of the main loop: it resolves each nominated key
   * against Plex, keeps the ones that live in this library, and renders only the
   * templates that actually consume `daysUntilAction`.
   *
   * Runs after the main loop so its progress counters extend an already-known
   * total. Processing only - departed seasons are handled by the cleanup pass.
   */
  private async applyMaintainerrSeasonOverlays(
    plexApi: PlexAPI,
    libraryId: string,
    config: OverlayLibraryConfig,
    sortedTemplates: OverlayTemplate[],
    maintainerrResult: MaintainerrFetchResult,
    checkCancelled?: () => boolean
  ): Promise<SeasonSubpassResult> {
    // A Maintainerr outage tells us nothing about which seasons departed, so we
    // neither process nor clean up. Leaving existing season overlays untouched is
    // the only safe read of "no data".
    if (maintainerrResult.status !== 'ok') {
      logger.warn(
        'Maintainerr unavailable - skipping season overlay subpass entirely',
        { label: 'OverlayLibrary', libraryId }
      );
      return {
        activeSeasonKeys: new Set(),
        resolutionComplete: false,
        cancelled: false,
      };
    }

    const collections = maintainerrResult.collections;
    const selection = collectSeasonCandidateKeys(collections);

    if (selection.legacyTypedCollections > 0) {
      // v2 users keep today's movie/show countdown and get no season overlays.
      logger.info(
        'Ignoring Maintainerr collections with a legacy numeric type; season overlays require Maintainerr 3.4.0+',
        {
          label: 'OverlayLibrary',
          libraryId,
          legacyTypedCollections: selection.legacyTypedCollections,
        }
      );
    }

    // A season Maintainerr tracks but does not identify is ambiguity, not absence.
    // Letting it read as absence would tell cleanup that every tracked season had
    // departed.
    let resolutionComplete = selection.mediaWithoutKey === 0;
    if (selection.mediaWithoutKey > 0) {
      logger.warn(
        'Maintainerr season collection has media entries without a Plex id; treating season resolution as incomplete',
        {
          label: 'OverlayLibrary',
          libraryId,
          mediaWithoutKey: selection.mediaWithoutKey,
        }
      );
    }

    const candidateKeys = selection.keys;

    logger.info('Maintainerr season subpass - candidates', {
      label: 'OverlayLibrary',
      libraryId,
      seasonCollections: selection.seasonCollections,
      candidateKeys: candidateKeys.size,
    });

    if (candidateKeys.size === 0) {
      // A healthy fetch with zero identifiable season members means every season
      // this library once tracked has departed.
      return {
        activeSeasonKeys: new Set(),
        resolutionComplete,
        cancelled: false,
      };
    }

    // Resolve candidates against Plex. getMetadataBatch swallows chunk errors into
    // a silently short map, so every miss is retried individually to tell a genuine
    // 404 apart from a transport failure.
    const keys = Array.from(candidateKeys);
    const batchMetadata = await plexApi.getMetadataBatch(keys);
    const resolved: PlexMetadata[] = [];

    for (const key of keys) {
      const batched = batchMetadata.get(key);
      if (batched) {
        resolved.push(batched);
        continue;
      }

      const safe = await plexApi.getMetadataSafe(key);
      if (safe.status === 'ok') {
        resolved.push(safe.meta);
      } else if (safe.status === 'error') {
        resolutionComplete = false;
      }
      // 'not_found' is a definite answer: the season is gone from Plex. It is not
      // active, and cleanup will drop any row we still hold for it.
    }

    const seasons = resolved.filter(
      (meta) =>
        meta.type === 'season' &&
        meta.librarySectionID?.toString() === libraryId
    );

    // Identical predicate to the one buildRenderContext uses for daysUntilAction,
    // over the identical collection array, so a season can never be processed here
    // and then render without a countdown.
    const activeSeasons = seasons.filter(
      (meta) => computeDaysUntilAction(collections, meta.ratingKey) !== null
    );
    const activeSeasonKeys = new Set(activeSeasons.map((s) => s.ratingKey));

    // Only templates that consume daysUntilAction have anything to say about a
    // season. Rendering the rest would stamp unrelated badges on season posters.
    const { extractUsedContextFields } = await import(
      '@server/utils/metadataHashing'
    );
    const seasonTemplates = sortedTemplates.filter((template) =>
      extractUsedContextFields(
        [template.getTemplateData()],
        [template.getApplicationCondition()]
      ).has('daysUntilAction')
    );

    logger.info('Maintainerr season subpass - resolved', {
      label: 'OverlayLibrary',
      libraryId,
      resolvedInLibrary: seasons.length,
      activeSeasons: activeSeasons.length,
      seasonTemplates: seasonTemplates.length,
      resolutionComplete,
    });

    if (seasonTemplates.length === 0 || activeSeasons.length === 0) {
      // Nothing to draw. Still report the active set so cleanup can restore the
      // seasons that have departed.
      return { activeSeasonKeys, resolutionComplete, cancelled: false };
    }

    this.updateProgress(libraryId, (p) => {
      p.totalItems += activeSeasons.length;
    });

    for (const meta of activeSeasons) {
      if (checkCancelled && checkCancelled()) {
        const progress = this.runningLibraries.get(libraryId);
        if (progress) {
          progress.state = 'cancelling';
        }

        logger.info('Overlay application cancelled during season subpass', {
          label: 'OverlayLibrary',
          libraryId,
          processedItems: progress?.currentItem || 0,
        });

        if (progress) {
          progress.state = 'cancelled';
          progress.completedAt = Date.now();
        }

        return { activeSeasonKeys, resolutionComplete, cancelled: true };
      }

      // Display only. The item below keeps Plex's bare season title ("Season 1")
      // so the `{title}` overlay variable, and the hash computed over it, stay
      // exactly what Plex reports.
      const displayTitle = meta.parentTitle
        ? `${meta.parentTitle} - ${meta.title}`
        : meta.title;

      this.updateProgress(libraryId, (p) => {
        p.currentTitle = displayTitle;
      });

      try {
        // Guid is deliberately absent. A season's Plex Guid holds a TMDB id from
        // TMDB's season namespace, which resolves to an unrelated show on the
        // endpoints this code calls. Every TMDB and Sonarr branch downstream is
        // gated on a tmdbId, so omitting it makes them all no-op.
        const item: PlexLibraryItem = {
          ratingKey: meta.ratingKey,
          parentRatingKey: meta.parentRatingKey,
          title: meta.title,
          guid: '',
          type: 'season',
          addedAt: meta.addedAt,
          updatedAt: meta.updatedAt,
          // `index` is the season number. `parentIndex` is deliberately omitted:
          // on a season Plex sets it to the SHOW's index (1 for Season 1 and for
          // Season 6 alike), and buildRenderContext would read it as the season
          // number. Leaving it out means a missing seasonNumber rather than a
          // silently wrong one if the override below is ever dropped.
          index: meta.index,
          Label: meta.Label,
          Media: [],
        };

        const result = await this.applyOverlaysToItem(
          plexApi,
          item,
          seasonTemplates,
          'show',
          libraryId,
          config.libraryName,
          collections,
          // A season is matched by its own ratingKey, never by the show-level
          // fallback, so the setting only has to be honest rather than special.
          seasonFallbackFor(config),
          // buildRenderContext reads a show item's `index` as an episode number.
          // Correct both fields here rather than withholding `index` from the item,
          // so the context says what a season actually is. `episodeNumber` must be
          // spread as an explicit undefined, not omitted, or the leaked value
          // survives the merge. contextOverrides is the last writer for these two
          // fields only because the spreads after it (releaseDateContext,
          // monitoringContext) are tmdbId-gated and a season has no tmdbId.
          { seasonNumber: meta.index, episodeNumber: undefined },
          // Seasons carry no Media, so there is no episode aggregation to apply.
          undefined,
          // Maintainerr nominated this season; if no template condition matches it,
          // leave its poster alone.
          true
        );

        this.updateProgress(libraryId, (p) => {
          p.currentItem++;

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
        this.updateProgress(libraryId, (p) => {
          p.currentItem++;
          p.errorCount++;

          p._recentItemTimes.push(Date.now());
          if (p._recentItemTimes.length > 20) {
            p._recentItemTimes.shift();
          }
        });

        logger.error('Failed to apply overlays to season', {
          label: 'OverlayLibrary',
          libraryId,
          ratingKey: meta.ratingKey,
          seasonTitle: displayTitle,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { activeSeasonKeys, resolutionComplete, cancelled: false };
  }

  /**
   * Restore the base poster of every season this library still tracks that no
   * longer has a live Maintainerr countdown, then stop tracking it.
   *
   * Recovery data - the metadata row and the stored base poster - is destroyed
   * only on a confirmed restore or a confirmed 404. Anything ambiguous keeps
   * both and retries next run. This mirrors Maintainerr's own revertItemInternal,
   * including its refinement that an *inconclusive* existence check still
   * attempts the restore: a redundant upload is cheap, a discarded base poster is
   * permanent. The one divergence is the no-backup case, where Maintainerr stops
   * tracking and we keep the row and retry - a stuck poster is the same outcome
   * either way, and keeping the row is the only version that can still heal.
   *
   * The restore reads the stored base poster directly (see restoreSeasonBasePoster)
   * rather than re-resolving it from the live Plex poster, so a row with a stale
   * ourOverlayPosterUrl can never have its own countdown overlay mistaken for a
   * base and written back as one.
   *
   * The CALLER decides whether running this is safe at all. An empty active set
   * means "restore everything", so it must only ever be reached from a
   * configuration-driven decision, never from a data read that could come back
   * empty because Plex or Maintainerr hiccuped.
   */
  private async cleanupDepartedSeasonOverlays(
    getPlexApi: () => Promise<PlexAPI>,
    libraryId: string,
    activeSeasonKeys: Set<string>,
    checkCancelled?: () => boolean
  ): Promise<void> {
    const metadataService = (
      await import('@server/lib/metadata/MetadataTrackingService')
    ).default;

    // Every tracked season, with no filter on the poster URL fields: the row is
    // the tracking, and a row whose fields were cleared by an earlier reset still
    // owns a stored base poster that has to be collected.
    const tracked = await metadataService.getOverlaidSeasonMetadata(libraryId);
    const departed = tracked.filter(
      (row) => !activeSeasonKeys.has(row.plexItemRatingKey)
    );

    if (departed.length === 0) {
      return;
    }

    logger.info('Restoring departed season overlays', {
      label: 'MaintainerrSeasonOverlay',
      libraryId,
      trackedSeasons: tracked.length,
      departedSeasons: departed.length,
    });

    // Only now is a Plex client worth building: the common case is a library that
    // has never tracked a season and returns above after one indexed query.
    const plexApi = await getPlexApi();
    const { plexBasePosterManager } = await import(
      '@server/lib/overlays/PlexBasePosterManager'
    );

    let restored = 0;
    let untracked = 0;
    let deferred = 0;
    let mismatched = 0;

    for (const row of departed) {
      const ratingKey = row.plexItemRatingKey;

      if (checkCancelled?.()) {
        logger.info('Season overlay cleanup cancelled', {
          label: 'MaintainerrSeasonOverlay',
          libraryId,
          restored,
          untracked,
          deferred,
          mismatched,
          remaining:
            departed.length - restored - untracked - deferred - mismatched,
        });
        return;
      }

      try {
        const existence = await plexApi.getMetadataSafe(ratingKey);
        const decision = classifySeasonCleanupAction(existence, libraryId);

        if (decision.action === 'untrack') {
          // Confirmed gone from Plex. Nothing to restore it onto, and nothing
          // will ever ask again, so the recovery data goes too.
          await plexBasePosterManager.deleteStoredBasePoster(
            libraryId,
            ratingKey
          );
          await metadataService.deleteItemMetadata(ratingKey);
          untracked++;

          logger.info(
            'Season no longer in Plex - stopped tracking its overlay',
            {
              label: 'MaintainerrSeasonOverlay',
              libraryId,
              ratingKey,
            }
          );
          continue;
        }

        if (decision.action === 'mismatch') {
          mismatched++;
          logger.warn(
            'Tracked season ratingKey no longer resolves to this season - skipping restore',
            {
              label: 'MaintainerrSeasonOverlay',
              libraryId,
              ratingKey,
              foundType: decision.foundType,
              foundLibrarySectionID: decision.foundLibrarySectionID,
            }
          );
          continue;
        }

        // Restore, including on an ambiguous existence check. This throws on any
        // failure of the critical path, landing in the catch below with the row
        // and the stored poster both intact.
        await restoreSeasonBasePoster(
          plexApi,
          libraryId,
          ratingKey,
          decision.title
        );

        // The upload succeeded, so Plex now holds the base poster and the stored
        // copy is no longer the only one. Delete the file BEFORE the row: it
        // throws on a real IO error, and a surviving file with no row would let a
        // stale base be baked into a future overlay via the first-time path.
        // The reverse order would trade that for a silently wrong poster, which
        // is the worse failure.
        await plexBasePosterManager.deleteStoredBasePoster(
          libraryId,
          ratingKey
        );

        try {
          await metadataService.deleteItemMetadata(ratingKey);
        } catch (rowError) {
          // The only unrecoverable ordering branch: poster restored, backup gone,
          // row still here. Every later run will attempt a restore that can no
          // longer find a backup and defer forever. Nothing is wrong on Plex - the
          // season already has its base poster - but the row needs a human. Say so
          // loudly rather than leaving an unexplained warn on every run.
          logger.error(
            'Season poster restored and its stored base poster deleted, but the tracked row could not be removed - delete it by hand or cleanup will defer on it every run',
            {
              label: 'MaintainerrSeasonOverlay',
              libraryId,
              ratingKey,
              error:
                rowError instanceof Error ? rowError.message : String(rowError),
            }
          );
          throw rowError;
        }

        restored++;
      } catch (error) {
        deferred++;
        logger.warn(
          'Failed to restore departed season overlay - keeping recovery data to retry next run',
          {
            label: 'MaintainerrSeasonOverlay',
            libraryId,
            ratingKey,
            error: error instanceof Error ? error.message : String(error),
          }
        );
      }
    }

    logger.info('Season overlay cleanup complete', {
      label: 'MaintainerrSeasonOverlay',
      libraryId,
      restored,
      untracked,
      deferred,
      mismatched,
    });
  }

  /**
   * Run episode media scan for a show library and store aggregated results.
   * Always fetches the lightweight episode list to detect new/changed/deleted episodes.
   * Only fetches stream-level detail for stale entries when HDR/DV fields are needed.
   */
  private async runEpisodeScan(
    plexApi: PlexAPI,
    libraryId: string,
    requiredContextFields: Set<string>
  ): Promise<void> {
    const { PlexEpisodeMediaScanner, resolveFetchedEpisodeDetail } =
      await import('./PlexEpisodeMediaScanner');
    const { EpisodeMediaAggregator } = await import('./EpisodeMediaAggregator');
    const { EpisodeMediaCacheService } = await import(
      './EpisodeMediaCacheService'
    );

    const needsStreamDetail =
      requiredContextFields.has('hdr') ||
      requiredContextFields.has('dolbyVision') ||
      requiredContextFields.has('dolbyVisionProfile') ||
      requiredContextFields.has('bitDepth') ||
      requiredContextFields.has('colorTrc') ||
      requiredContextFields.has('episodeHdrCount') ||
      requiredContextFields.has('episodeHdrPercent') ||
      requiredContextFields.has('episodeDvCount') ||
      requiredContextFields.has('episodeDvPercent');

    const settings = getSettings();
    const serverId = settings.plex?.machineId || 'default';

    const cacheService = new EpisodeMediaCacheService();
    const scanner = new PlexEpisodeMediaScanner(plexApi);

    // Always fetch lightweight episode list to detect new/changed/deleted episodes
    const freshLightweight = await scanner.scanLibraryEpisodes(
      libraryId,
      false
    );

    const { episodes: cachedEpisodes, hasStreamDetail: cachedHasStreamDetail } =
      await cacheService.getCachedEpisodes(serverId, libraryId);

    // Compare against cache to find stale/missing entries
    const staleKeys = cacheService.getStaleRatingKeys(
      cachedEpisodes,
      freshLightweight
    );
    const cachedByKey = new Map(cachedEpisodes.map((c) => [c.ratingKey, c]));
    const currentKeys = new Set(freshLightweight.map((e) => e.ratingKey));

    // If templates now need stream detail but cache was saved without it,
    // treat all entries as stale so stream detail gets fetched
    const needsDetailUpgrade = needsStreamDetail && !cachedHasStreamDetail;

    let episodes: EpisodeMediaInfo[];

    if (
      staleKeys.size === 0 &&
      !needsDetailUpgrade &&
      cachedEpisodes.length >= freshLightweight.length
    ) {
      // All episodes are cached and fresh — filter to current episodes only
      episodes = cachedEpisodes.filter((c) => currentKeys.has(c.ratingKey));
      logger.info('Using cached episode media data', {
        label: 'EpisodeScanner',
        libraryId,
        cachedCount: episodes.length,
      });
    } else if (
      needsStreamDetail &&
      (staleKeys.size > 0 || needsDetailUpgrade)
    ) {
      // Fetch stream detail for stale or detail-upgrade episodes
      const keysToFetch = needsDetailUpgrade
        ? freshLightweight.map((e) => e.ratingKey)
        : [...staleKeys];
      const batchMetadata = await plexApi.getMetadataBatch(keysToFetch);

      // Merge: reuse cached rows for fresh entries, and apply the freshly
      // fetched stream detail (or lack of it) for stale / detail-upgrade
      // entries. resolveFetchedEpisodeDetail owns the per-row hasStreamDetail
      // decision so an empty or missing stream can't masquerade as detailed.
      episodes = freshLightweight.map((ep) => {
        if (
          !needsDetailUpgrade &&
          !staleKeys.has(ep.ratingKey) &&
          cachedByKey.has(ep.ratingKey)
        ) {
          return cachedByKey.get(ep.ratingKey)!;
        }
        return resolveFetchedEpisodeDetail(ep, batchMetadata.get(ep.ratingKey));
      });

      await cacheService.saveEpisodes(serverId, libraryId, episodes);
    } else {
      // No stream detail needed — use lightweight data
      episodes = freshLightweight;
      if (staleKeys.size > 0) {
        await cacheService.saveEpisodes(serverId, libraryId, episodes);
      }
    }

    await cacheService.cleanExpired(serverId, libraryId);

    const aggregator = new EpisodeMediaAggregator();
    const aggregated = aggregator.aggregateByShow(episodes);

    this.aggregatedMediaByLibrary.set(libraryId, aggregated);
    // Fresh authoritative data written; drop the collection-path memo so it
    // re-reads the updated cache on its next call.
    this.aggregatedMediaCacheMemo.delete(libraryId);

    logger.info('Episode media aggregation complete', {
      label: 'EpisodeScanner',
      libraryId,
      episodeCount: episodes.length,
      showCount: aggregated.size,
    });
  }

  /**
   * Load per-show episode media aggregation from the persisted cache without
   * re-scanning Plex. Used by the collection / quick-sync overlay path so
   * show-level quality badges survive background syncs (the symptom of #32).
   *
   * Design notes / trade-offs vs. the full runEpisodeScan path:
   * - No Plex API calls: reads only the cache runEpisodeScan already wrote. The
   *   result is memoised per library (short TTL, plus invalidation whenever
   *   runEpisodeScan rewrites the cache) so the many per-collection calls in one
   *   sync cycle don't each re-query and re-aggregate the whole library.
   * - Does NOT mutate the shared aggregatedMediaByLibrary map; the caller passes
   *   the returned map straight to applyOverlaysToItem, so it cannot race a
   *   concurrent full library scan writing that map.
   * - Reflects the cache as of the last scan. It does not re-filter to
   *   currently-existing episodes, so an episode deleted from Plex can still
   *   count toward a badge until the next nightly scan self-heals it. Resolution
   *   comes from the lightweight scan and is correct immediately; HDR/DV only
   *   become correct once a full scan has written stream detail. Both windows
   *   close at the next runEpisodeScan.
   * - Returns undefined when the cache is empty (e.g. before the first scan), in
   *   which case items fall back to base context exactly as before.
   */
  private async getAggregatedMediaFromCache(
    libraryId: string
  ): Promise<Map<string, AggregatedMediaInfo> | undefined> {
    const memo = this.aggregatedMediaCacheMemo.get(libraryId);
    if (
      memo &&
      Date.now() - memo.at < OverlayLibraryService.AGGREGATION_MEMO_TTL_MS
    ) {
      return memo.aggregated;
    }

    const { EpisodeMediaAggregator } = await import('./EpisodeMediaAggregator');
    const { EpisodeMediaCacheService } = await import(
      './EpisodeMediaCacheService'
    );

    const settings = getSettings();
    const serverId = settings.plex?.machineId || 'default';

    const cacheService = new EpisodeMediaCacheService();
    const { episodes } = await cacheService.getCachedEpisodes(
      serverId,
      libraryId
    );

    const aggregated =
      episodes.length === 0
        ? undefined
        : new EpisodeMediaAggregator().aggregateByShow(episodes);

    this.aggregatedMediaCacheMemo.set(libraryId, {
      at: Date.now(),
      aggregated,
    });

    if (aggregated) {
      logger.info('Loaded episode media aggregation from cache', {
        label: 'OverlayLibrary',
        libraryId,
        episodeCount: episodes.length,
        showCount: aggregated.size,
      });
    }

    return aggregated;
  }
}

export const overlayLibraryService = new OverlayLibraryService();

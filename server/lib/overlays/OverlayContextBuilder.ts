import ImdbAPI from '@server/api/imdb';
import ImdbRatingsAPI from '@server/api/imdbRatings';
import type { MaintainerrCollection } from '@server/api/maintainerr';
import type { PlexLibraryItem } from '@server/api/plexapi';
import RottenTomatoes, { type RTRating } from '@server/api/rottentomatoes';
import type { RadarrMovie } from '@server/api/servarr/radarr';
import type { SonarrSeries } from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbWatchProviderDetails,
  TmdbWatchProviders,
} from '@server/api/themoviedb/interfaces';
import TvdbAPI from '@server/api/tvdb';
import cacheManager from '@server/lib/cache';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import {
  isAirDateUpcoming,
  toServerCalendarDate,
} from '@server/utils/dateHelpers';
import { getAdaptiveTtl, getNullRatingTtl } from './adaptiveTtl';
import { hasStreamingProviderIcon } from './DefaultMappingsService';
import type { SeasonFallbackMode } from './maintainerrCountdown';
import { computeDaysUntilAction } from './maintainerrCountdown';
import type { OverlayRenderContext } from './OverlayTemplateRenderer';

// Captured defensively: the app replaces the global Intl with the andyearnshaw
// `intl` SSR polyfill (src/pages/_app.tsx), which does NOT provide DisplayNames.
// This server module currently loads before that swap so native DisplayNames is
// available, but construct it under a guard so a future load-order change can
// never turn this module-scope line into a crash (`Intl.DisplayNames is not a
// constructor`). resolveLanguageName falls back to the raw value when it is
// unavailable. The no-restricted-syntax rule below bans Intl constructors in
// server code; this one guarded, caught use is the deliberate exception.
const _langDisplayNames: Intl.DisplayNames | undefined = (() => {
  try {
    // eslint-disable-next-line no-restricted-syntax -- guarded + try/caught
    return new Intl.DisplayNames(['en'], { type: 'language' });
  } catch {
    return undefined;
  }
})();

/**
 * Convert an ISO 639-2 language code to its English display name.
 */
function resolveLanguageName(code: string, fallback: string): string {
  try {
    return _langDisplayNames?.of(code) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Result of building render context
 * Includes the context and whether any critical API calls failed
 */
export interface BuildRenderContextResult {
  context: OverlayRenderContext;
  /**
   * True if a critical API (IMDb ratings) failed with a transient error.
   * When true, the caller should skip overlay application to avoid
   * regenerating posters with incomplete data.
   */
  criticalApiFailed: boolean;
}

/**
 * Shared IMDb client for reuse across overlay operations
 */
let sharedImdbClient: ImdbAPI | undefined;

/**
 * Get or create shared IMDb client
 */
function getImdbClient(): ImdbAPI {
  if (!sharedImdbClient) {
    sharedImdbClient = new ImdbAPI();
  }
  return sharedImdbClient;
}

/**
 * Shared TVDB client for reuse across overlay operations
 */
let sharedTvdbClient: TvdbAPI | undefined;

/**
 * Get or create shared TVDB client
 */
function getTvdbClient(): TvdbAPI {
  if (!sharedTvdbClient) {
    sharedTvdbClient = new TvdbAPI();
  }
  return sharedTvdbClient;
}

/**
 * Get all movies from a Radarr instance (with optional caching)
 */
async function getRadarrMovies(
  radarrSettings: {
    hostname: string;
    port: number;
    useSsl: boolean;
    baseUrl?: string;
    apiKey: string;
  },
  cache?: Map<string, RadarrMovie[]>
): Promise<RadarrMovie[]> {
  const RadarrAPI = (await import('@server/api/servarr/radarr')).default;

  // Build URL manually (same pattern as buildUrl)
  const protocol = radarrSettings.useSsl ? 'https' : 'http';
  const url = `${protocol}://${radarrSettings.hostname}:${radarrSettings.port}${
    radarrSettings.baseUrl || ''
  }/api/v3`;
  const cacheKey = url;

  // Check cache if provided
  if (cache) {
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const radarr = new RadarrAPI({
    url,
    apiKey: radarrSettings.apiKey,
  });

  const movies = await radarr.getMovies();

  // Store in cache if provided
  if (cache) {
    cache.set(cacheKey, movies);
    logger.debug('Cached Radarr movies', {
      label: 'OverlayContextBuilder',
      url,
      movieCount: movies.length,
    });
  }

  return movies;
}

/**
 * Get all series from a Sonarr instance (with optional caching)
 */
async function getSonarrSeries(
  sonarrSettings: {
    hostname: string;
    port: number;
    useSsl: boolean;
    baseUrl?: string;
    apiKey: string;
  },
  cache?: Map<string, SonarrSeries[]>
): Promise<SonarrSeries[]> {
  const SonarrAPI = (await import('@server/api/servarr/sonarr')).default;

  // Build URL manually (same pattern as buildUrl)
  const protocol = sonarrSettings.useSsl ? 'https' : 'http';
  const url = `${protocol}://${sonarrSettings.hostname}:${sonarrSettings.port}${
    sonarrSettings.baseUrl || ''
  }/api/v3`;
  const cacheKey = url;

  // Check cache if provided
  if (cache) {
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const sonarr = new SonarrAPI({
    url,
    apiKey: sonarrSettings.apiKey,
  });

  // NOTE: a fetch failure here throws (per-item). We deliberately do NOT
  // negative-cache the failure: this cache is shared with checkMonitoringStatus
  // (which reads a throw as "not in Sonarr"), and the cache spans concurrent
  // library jobs, so a sticky failure marker would turn one transient blip into
  // a job-wide strip of monitoring overlays. Bounding the retry cost of a
  // persistently-down instance is a separate operational concern.
  const series = await sonarr.getSeries();

  // Store in cache if provided
  if (cache) {
    cache.set(cacheKey, series);
    logger.debug('Cached Sonarr series', {
      label: 'OverlayContextBuilder',
      url,
      seriesCount: series.length,
    });
  }

  return series;
}

/**
 * Get TVDB ID from TMDB ID for TV shows
 * Required for Sonarr lookups since Sonarr uses TVDB IDs
 */
export async function getTvdbIdFromTmdb(
  tmdbId: number
): Promise<number | undefined> {
  try {
    const tmdbClient = new TheMovieDb();
    const showDetails = await tmdbClient.getTvShow({ tvId: tmdbId });

    return showDetails.external_ids?.tvdb_id;
  } catch (error) {
    logger.debug('Failed to get TVDB ID from TMDB', {
      label: 'OverlayContextBuilder',
      tmdbId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

// Sentinel value to distinguish "checked, no rating" from "not yet checked"
const RT_NULL_SENTINEL = '__RT_NULL__';

// In-flight RT request deduplication to prevent thundering herd
const rtInflightRequests = new Map<string, Promise<RTRating | null>>();

/**
 * Build context for dynamic field replacement
 *
 * @param item - Plex library item to build context for
 * @param mediaType - Media type ('movie' or 'show')
 * @param isPlaceholder - Whether this is a placeholder item
 * @param maintainerrCollections - Optional cached Maintainerr collections
 * @param preloadedImdbRatings - Optional pre-fetched IMDb ratings map (imdbId -> rating | null)
 *                               When provided, skips individual IMDb API calls for items in the map.
 *                               null means "checked, no rating available" (avoids redundant API calls).
 * @param seasonFallback - Whether a show with no Maintainerr schedule of its own may
 *                         inherit one from its seasons, per the library's season-countdown
 *                         toggles. Defaults to 'off': a caller that has not read the config
 *                         cannot put a season's deletion date on a show poster.
 * @returns Object containing the context and a flag indicating if critical APIs failed.
 *          When criticalApiFailed is true, callers should skip overlay application
 *          to avoid regenerating posters with incomplete data.
 */
export function extractStreamingProvider(
  watchProviderResults:
    | { [iso_3166_1: string]: TmdbWatchProviders }
    | undefined,
  region: string
): { name: string; id: number } | undefined {
  if (!watchProviderResults) return undefined;

  const regionData = watchProviderResults[region];
  if (!regionData?.flatrate?.length) return undefined;

  const sorted = [...regionData.flatrate].sort(
    (a: TmdbWatchProviderDetails, b: TmdbWatchProviderDetails) =>
      (a.display_priority ?? Number.MAX_SAFE_INTEGER) -
        (b.display_priority ?? Number.MAX_SAFE_INTEGER) ||
      a.provider_name.localeCompare(b.provider_name)
  );

  // Prefer a provider that has a matching icon to avoid empty overlays
  for (const provider of sorted) {
    if (
      hasStreamingProviderIcon(provider.provider_name, provider.provider_id)
    ) {
      return { name: provider.provider_name, id: provider.provider_id };
    }
  }

  return undefined;
}

export async function buildRenderContext(
  item: PlexLibraryItem,
  mediaType: 'movie' | 'show',
  isPlaceholder = false,
  maintainerrCollections?: MaintainerrCollection[],
  preloadedImdbRatings?: Map<string, number | null>,
  requiredContextFields?: Set<string>,
  seasonFallback: SeasonFallbackMode = 'off'
): Promise<BuildRenderContextResult> {
  // Track if critical APIs failed (IMDb rating is critical for rating overlays)
  let criticalApiFailed = false;

  const context: OverlayRenderContext = {
    title: item.title,
    year: item.year,
    isPlaceholder,
    mediaType,
    downloaded: !isPlaceholder, // Real items in Plex are downloaded, placeholders are not
  };

  // Extract Plex user rating if available
  if (item.userRating !== undefined) {
    context.plexUserRating = item.userRating;
  }

  // Extract TMDb ID and IMDb ID from Plex GUIDs
  // Using Plex GUID for IMDb ID ensures consistency with prefetch cache
  let tmdbId: number | undefined;
  let imdbIdFromGuid: string | undefined;

  if (item.Guid && Array.isArray(item.Guid)) {
    // Extract TMDB ID
    const tmdbGuid = item.Guid.find((g) => g.id?.includes('tmdb://'));
    if (tmdbGuid) {
      const match = tmdbGuid.id.match(/tmdb:\/\/(\d+)/);
      if (match) {
        tmdbId = parseInt(match[1]);
      }
    }

    // Extract IMDb ID directly from Plex GUID (same as prefetch does)
    const imdbGuid = item.Guid.find((g) => g.id?.startsWith('imdb://'));
    if (imdbGuid) {
      imdbIdFromGuid = imdbGuid.id.replace('imdb://', '');
    }
  }

  // Use IMDb ID from Plex GUID first, fall back to TMDB external_ids
  let imdbId = imdbIdFromGuid;

  if (tmdbId) {
    try {
      // Fetch TMDb data
      const tmdbClient = new TheMovieDb();
      const tmdbData =
        mediaType === 'movie'
          ? await tmdbClient.getMovie({ movieId: tmdbId })
          : await tmdbClient.getTvShow({ tvId: tmdbId });

      // Only use TMDB external_ids as fallback if no IMDb ID from Plex GUID
      if (!imdbId && tmdbData.external_ids?.imdb_id) {
        imdbId = tmdbData.external_ids.imdb_id;
      }

      // IMDb ratings - skip if no template uses IMDb fields
      const needsImdbRatings =
        !requiredContextFields ||
        requiredContextFields.has('imdbRating') ||
        requiredContextFields.has('isImdbTop250') ||
        requiredContextFields.has('imdbTop250Rank');

      if (needsImdbRatings && imdbId) {
        // IMDb rating - check preloaded cache first
        // preloadedImdbRatings contains: number (has rating), null (checked, no rating), undefined (not checked)
        const preloadedRating = preloadedImdbRatings?.get(imdbId);
        if (preloadedRating !== undefined) {
          if (preloadedRating !== null) {
            // Use pre-fetched rating (batch fetched before item processing)
            context.imdbRating = preloadedRating;
            logger.debug('Using preloaded IMDb rating', {
              label: 'OverlayContextBuilder',
              imdbId,
              itemTitle: item.title,
              rating: preloadedRating,
            });
          }
          // If preloadedRating === null, we already checked and there's no rating - skip API call
        } else {
          // Fallback to individual API call (for items not in preloaded batch)
          // This is slow and should be rare - log it for debugging
          logger.warn(
            'IMDb rating not in preloaded cache, making individual API call',
            {
              label: 'OverlayContextBuilder',
              imdbId,
              itemTitle: item.title,
              preloadedMapExists: preloadedImdbRatings !== undefined,
              preloadedMapSize: preloadedImdbRatings?.size ?? 0,
            }
          );
          try {
            const imdbApi = new ImdbRatingsAPI();
            const imdbRatings = await imdbApi.getRatings(imdbId);
            if (imdbRatings.length > 0 && imdbRatings[0].rating !== null) {
              context.imdbRating = imdbRatings[0].rating;
              // Cache the result for any duplicate IMDb IDs in this run
              preloadedImdbRatings?.set(imdbId, imdbRatings[0].rating);
            } else {
              // Cache null to prevent re-fetching for duplicates
              preloadedImdbRatings?.set(imdbId, null);
            }
          } catch (error) {
            // Mark as critical API failure - this prevents regenerating posters
            // with missing IMDb ratings, which would strip all rating overlays
            criticalApiFailed = true;
            logger.warn(
              'IMDb rating fetch failed - marking as critical failure',
              {
                label: 'OverlayContextBuilder',
                imdbId,
                itemTitle: item.title,
                error: error instanceof Error ? error.message : String(error),
              }
            );
          }
        }

        // IMDb Top 250 check - skip if no template uses Top 250 fields
        const needsTop250 =
          !requiredContextFields ||
          requiredContextFields.has('isImdbTop250') ||
          requiredContextFields.has('imdbTop250Rank');

        if (needsTop250) {
          try {
            const imdbClient = getImdbClient();
            const imdbMediaType: 'movie' | 'tv' =
              mediaType === 'show' ? 'tv' : 'movie';
            const top250Result = await imdbClient.checkTop250(
              imdbId,
              imdbMediaType
            );

            if (top250Result.isTop250) {
              context.isImdbTop250 = true;
              context.imdbTop250Rank = top250Result.rank;
            }
          } catch (error) {
            logger.debug('Failed to check IMDb Top 250', {
              label: 'OverlayContextBuilder',
              imdbId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      // Rotten Tomatoes ratings - skip if no template uses RT fields
      const needsRtRatings =
        !requiredContextFields ||
        requiredContextFields.has('rtCriticsScore') ||
        requiredContextFields.has('rtAudienceScore') ||
        requiredContextFields.has('rtCertifiedFresh');

      if (needsRtRatings && tmdbId) {
        // Use TMDb title for RT lookup — Plex titles may include year suffixes
        // (e.g. "Young Sherlock 2026") that break RT fuzzy matching
        const rtTitle =
          mediaType === 'movie'
            ? (tmdbData as { title: string }).title
            : (tmdbData as { name: string }).name;

        // Use TMDB ID as cache key (stable, avoids title/year collision issues)
        const rtCacheKey = `rt:${mediaType}:${tmdbId}`;
        const rtCache = cacheManager.getCache('rt-ratings');

        // Check cache first
        const cachedRt = rtCache.data.get<string | RTRating>(rtCacheKey);
        if (cachedRt !== undefined) {
          if (cachedRt === RT_NULL_SENTINEL) {
            // Cached "no rating" - skip API call
            logger.debug('Using cached RT null result', {
              label: 'OverlayContextBuilder',
              title: context.title,
              tmdbId,
            });
          } else {
            // Cached rating found
            const rtRating = cachedRt as RTRating;
            context.rtCriticsScore = rtRating.criticsScore;
            context.rtAudienceScore = rtRating.audienceScore;
            context.rtCertifiedFresh =
              rtRating.criticsRating === 'Certified Fresh';
            context.rtVerifiedHot = rtRating.verifiedHot ?? false;
            logger.debug('Using cached RT ratings', {
              label: 'OverlayContextBuilder',
              title: context.title,
              tmdbId,
              criticsScore: rtRating.criticsScore,
              audienceScore: rtRating.audienceScore,
              certifiedFresh: context.rtCertifiedFresh,
              verifiedHot: context.rtVerifiedHot,
            });
          }
        } else {
          // Check for in-flight request (deduplication for parallel processing)
          const inflightPromise = rtInflightRequests.get(rtCacheKey);
          if (inflightPromise) {
            // Wait for existing request
            try {
              const rtRating = await inflightPromise;
              if (rtRating) {
                context.rtCriticsScore = rtRating.criticsScore;
                context.rtAudienceScore = rtRating.audienceScore;
                context.rtCertifiedFresh =
                  rtRating.criticsRating === 'Certified Fresh';
              }
              logger.debug('Used in-flight RT request result', {
                label: 'OverlayContextBuilder',
                title: context.title,
                tmdbId,
                hasRating: !!rtRating,
              });
            } catch {
              // In-flight request failed, we'll skip RT for this item
            }
          } else {
            // Not in cache and no in-flight request - fetch from API
            const fetchPromise = (async (): Promise<RTRating | null> => {
              const rtClient = new RottenTomatoes();
              return mediaType === 'movie'
                ? await rtClient.getMovieRatings(
                    rtTitle || context.title || '',
                    context.year || 0
                  )
                : await rtClient.getTVRatings(
                    rtTitle || context.title || '',
                    context.year
                  );
            })();

            // Register in-flight request
            rtInflightRequests.set(rtCacheKey, fetchPromise);

            try {
              const rtRating = await fetchPromise;
              const ttl = getAdaptiveTtl(context.year);
              const nullTtl = getNullRatingTtl(context.year);

              if (rtRating) {
                context.rtCriticsScore = rtRating.criticsScore;
                context.rtAudienceScore = rtRating.audienceScore;
                context.rtCertifiedFresh =
                  rtRating.criticsRating === 'Certified Fresh';
                // Cache the rating with adaptive TTL
                rtCache.data.set(rtCacheKey, rtRating, ttl);
                logger.debug('Fetched and cached RT ratings', {
                  label: 'OverlayContextBuilder',
                  title: context.title,
                  tmdbId,
                  criticsScore: rtRating.criticsScore,
                  audienceScore: rtRating.audienceScore,
                  certifiedFresh: context.rtCertifiedFresh,
                  ttlHours: Math.round(ttl / 3600),
                });
              } else {
                // Cache the null result with adaptive TTL
                rtCache.data.set(rtCacheKey, RT_NULL_SENTINEL, nullTtl);
                logger.debug('RT rating not found, cached null', {
                  label: 'OverlayContextBuilder',
                  title: context.title,
                  tmdbId,
                  year: context.year,
                  nullTtlHours: Math.round(nullTtl / 3600),
                });
              }
            } catch (error) {
              logger.debug('Failed to fetch RT rating', {
                label: 'OverlayContextBuilder',
                title: context.title,
                tmdbId,
                error: error instanceof Error ? error.message : String(error),
              });
            } finally {
              // Clean up in-flight request
              rtInflightRequests.delete(rtCacheKey);
            }
          }
        }
      }

      // Movie-specific metadata
      if (mediaType === 'movie' && 'credits' in tmdbData) {
        const director = tmdbData.credits?.crew?.find(
          (c) => c.job === 'Director'
        );
        if (director) {
          context.director = director.name;
        }
      }

      // Studio/Network
      if (
        'production_companies' in tmdbData &&
        tmdbData.production_companies?.[0]
      ) {
        context.studio = tmdbData.production_companies[0].name;
      }

      // Network (TV shows)
      if ('networks' in tmdbData && tmdbData.networks?.[0]) {
        context.network = tmdbData.networks[0].name;
      }

      // Country of Origin (ISO codes like "US", "GB", "DE")
      // Both movies and TV shows have origin_country and production_countries
      if ('origin_country' in tmdbData && tmdbData.origin_country?.length > 0) {
        context.originCountry = tmdbData.origin_country[0];
        context.originCountries = tmdbData.origin_country;
      }
      if (
        'production_countries' in tmdbData &&
        tmdbData.production_countries?.length > 0
      ) {
        context.productionCountry = tmdbData.production_countries[0].iso_3166_1;
        context.productionCountries = tmdbData.production_countries.map(
          (c: { iso_3166_1: string }) => c.iso_3166_1
        );
      }

      // Genre (concatenate all genres for matching)
      if (
        'genres' in tmdbData &&
        tmdbData.genres &&
        tmdbData.genres.length > 0
      ) {
        context.genre = tmdbData.genres
          .map((g: { name: string }) => g.name)
          .join(', ');
      }

      // Runtime
      if (mediaType === 'movie' && 'runtime' in tmdbData) {
        context.runtime = tmdbData.runtime;
        // Format runtime as "2h 16m" or "47m"
        if (tmdbData.runtime) {
          const hours = Math.floor(tmdbData.runtime / 60);
          const minutes = tmdbData.runtime % 60;
          if (hours > 0) {
            context.runtimeHHMM =
              minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
          } else {
            context.runtimeHHMM = `${minutes}m`;
          }
        }
      } else if (
        mediaType === 'show' &&
        'episode_run_time' in tmdbData &&
        tmdbData.episode_run_time?.[0]
      ) {
        context.runtime = tmdbData.episode_run_time[0];
        // Format runtime as "2h 16m" or "47m"
        const runtimeValue = tmdbData.episode_run_time[0];
        if (runtimeValue) {
          const hours = Math.floor(runtimeValue / 60);
          const minutes = runtimeValue % 60;
          if (hours > 0) {
            context.runtimeHHMM =
              minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
          } else {
            context.runtimeHHMM = `${minutes}m`;
          }
        }
      }

      // TMDB Status (TV shows only) - using Kometa's user-friendly mapping
      if (mediaType === 'show' && 'number_of_seasons' in tmdbData) {
        context.totalSeasons = tmdbData.number_of_seasons;
      }

      if (mediaType === 'show' && 'status' in tmdbData) {
        const rawStatus = tmdbData.status;

        // Map TMDB status to user-friendly names (based on Kometa)
        let mappedStatus: string;
        switch (rawStatus) {
          case 'Returning Series':
            mappedStatus = 'RETURNING';
            break;
          case 'Ended':
            mappedStatus = 'ENDED';
            break;
          case 'Canceled':
            mappedStatus = 'CANCELLED';
            break;
          case 'Planned':
            mappedStatus = 'PLANNED';
            break;
          case 'In Production':
            mappedStatus = 'IN PRODUCTION';
            break;
          case 'Pilot':
            mappedStatus = 'PILOT';
            break;
          default:
            mappedStatus = rawStatus.toUpperCase();
        }

        // Check if an episode aired in last 15 days to determine "AIRING" status
        // Only override to AIRING if status is "Returning Series"
        // Use last_episode_to_air.air_date for accuracy (more reliable than last_air_date)
        if (
          rawStatus === 'Returning Series' &&
          'last_episode_to_air' in tmdbData &&
          tmdbData.last_episode_to_air?.air_date
        ) {
          const lastAired = new Date(tmdbData.last_episode_to_air.air_date);
          const daysSinceAired = Math.floor(
            (Date.now() - lastAired.getTime()) / (1000 * 60 * 60 * 24)
          );

          logger.debug('Checking AIRING status', {
            label: 'OverlayContextBuilder',
            title: context.title,
            lastEpisodeAirDate: tmdbData.last_episode_to_air.air_date,
            daysSinceAired,
            threshold: 15,
          });

          if (daysSinceAired <= 15) {
            mappedStatus = 'AIRING';
          }
        }

        context.tmdbStatus = mappedStatus;
      }

      // TVDB Status (TV shows only)
      if (mediaType === 'show') {
        try {
          // Extract TVDB ID: prefer Plex GUID, fallback to TMDB external_ids
          let tvdbId: number | undefined;

          if (item.Guid && Array.isArray(item.Guid)) {
            const tvdbGuid = item.Guid.find((g) => g.id?.includes('tvdb://'));
            if (tvdbGuid) {
              const match = tvdbGuid.id.match(/tvdb:\/\/(\d+)/);
              if (match) {
                tvdbId = parseInt(match[1]);
              }
            }
          }

          if (!tvdbId && 'external_ids' in tmdbData) {
            tvdbId = tmdbData.external_ids?.tvdb_id;
          }

          if (tvdbId) {
            const tvdbClient = getTvdbClient();
            const tvdbSeries = await tvdbClient.getSeriesById(tvdbId);
            const rawTvdbStatus = tvdbSeries.status?.name ?? '';

            let mappedTvdbStatus: string;
            switch (rawTvdbStatus) {
              case 'Continuing':
                mappedTvdbStatus = 'RETURNING';
                break;
              case 'Ended':
                mappedTvdbStatus = 'ENDED';
                break;
              case 'Upcoming':
                mappedTvdbStatus = 'PLANNED';
                break;
              default:
                mappedTvdbStatus = rawTvdbStatus.toUpperCase();
            }

            // Override to AIRING if an episode aired within the last 15 days
            if (rawTvdbStatus === 'Continuing' && tvdbSeries.lastAired) {
              const lastAired = new Date(tvdbSeries.lastAired);
              const daysSinceAired = Math.floor(
                (Date.now() - lastAired.getTime()) / (1000 * 60 * 60 * 24)
              );
              if (daysSinceAired <= 15) {
                mappedTvdbStatus = 'AIRING';
              }
            }

            context.tvdbStatus = mappedTvdbStatus;
          }
        } catch (error) {
          logger.debug('Failed to fetch TVDB status', {
            label: 'OverlayContextBuilder',
            title: context.title,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Content ratings / certifications (per-country)
      // Stored as contentRating:{countryCode} for per-element country selection
      if (mediaType === 'movie' && 'release_dates' in tmdbData) {
        const releaseResults = tmdbData.release_dates?.results;
        if (releaseResults && Array.isArray(releaseResults)) {
          for (const countryEntry of releaseResults) {
            const countryCode = countryEntry.iso_3166_1;
            // Find the first non-empty certification for this country
            const certification = countryEntry.release_dates
              ?.map((rd: { certification: string }) => rd.certification)
              .find((cert: string) => cert && cert.trim() !== '');
            if (certification) {
              context[`contentRating:${countryCode}`] = certification;
            }
          }
        }
      } else if (mediaType === 'show' && 'content_ratings' in tmdbData) {
        const ratingResults = tmdbData.content_ratings?.results;
        if (ratingResults && Array.isArray(ratingResults)) {
          for (const ratingEntry of ratingResults) {
            if (ratingEntry.rating && ratingEntry.rating.trim() !== '') {
              context[`contentRating:${ratingEntry.iso_3166_1}`] =
                ratingEntry.rating;
            }
          }
        }
      }

      // Streaming provider
      const needsStreamingProvider =
        !requiredContextFields ||
        requiredContextFields.has('streamingProvider') ||
        requiredContextFields.has('streamingProviderId');

      if (needsStreamingProvider) {
        const settings = getSettings();
        const region = settings.overlays?.watchProviderRegion || 'US';
        const provider = extractStreamingProvider(
          tmdbData['watch/providers']?.results,
          region
        );
        if (provider) {
          context.streamingProvider = provider.name;
          context.streamingProviderId = provider.id;
        }
      }
    } catch (error) {
      logger.debug('Failed to fetch external metadata', {
        label: 'OverlayContextBuilder',
        tmdbId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (imdbId) {
    // No TMDB ID but we have IMDb ID from Plex GUID
    // Check if templates need IMDb ratings
    const needsImdbRatings =
      !requiredContextFields ||
      requiredContextFields.has('imdbRating') ||
      requiredContextFields.has('isImdbTop250') ||
      requiredContextFields.has('imdbTop250Rank');

    if (needsImdbRatings) {
      // Fetch IMDb rating
      const preloadedRating = preloadedImdbRatings?.get(imdbId);
      if (preloadedRating !== undefined) {
        if (preloadedRating !== null) {
          context.imdbRating = preloadedRating;
          logger.debug('Using preloaded IMDb rating (no TMDB)', {
            label: 'OverlayContextBuilder',
            imdbId,
            itemTitle: item.title,
            rating: preloadedRating,
          });
        }
      } else {
        // Fallback to individual API call
        try {
          const imdbApi = new ImdbRatingsAPI();
          const imdbRatings = await imdbApi.getRatings(imdbId);
          if (imdbRatings.length > 0 && imdbRatings[0].rating !== null) {
            context.imdbRating = imdbRatings[0].rating;
            // Cache the result for any duplicate IMDb IDs in this run
            preloadedImdbRatings?.set(imdbId, imdbRatings[0].rating);
          } else {
            // Cache null to prevent re-fetching for duplicates
            preloadedImdbRatings?.set(imdbId, null);
          }
        } catch (error) {
          criticalApiFailed = true;
          logger.warn(
            'IMDb rating fetch failed - marking as critical failure',
            {
              label: 'OverlayContextBuilder',
              imdbId,
              itemTitle: item.title,
              error: error instanceof Error ? error.message : String(error),
            }
          );
        }
      }

      // IMDb Top 250 check - skip if no template uses Top 250 fields
      const needsTop250 =
        !requiredContextFields ||
        requiredContextFields.has('isImdbTop250') ||
        requiredContextFields.has('imdbTop250Rank');

      if (needsTop250) {
        try {
          const imdbClient = getImdbClient();
          const imdbMediaType: 'movie' | 'tv' =
            mediaType === 'show' ? 'tv' : 'movie';
          const top250Result = await imdbClient.checkTop250(
            imdbId,
            imdbMediaType
          );

          if (top250Result.isTop250) {
            context.isImdbTop250 = true;
            context.imdbTop250Rank = top250Result.rank;
          }
        } catch (error) {
          logger.debug('Failed to check IMDb Top 250', {
            label: 'OverlayContextBuilder',
            imdbId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  // Plex-specific metadata from Media (extract if available, even for placeholders)
  if (item.Media?.[0]) {
    const media = item.Media[0];

    // Resolution - use raw value from Plex (e.g., "720", "1080", "4k")
    if (media.videoResolution) {
      context.resolution = media.videoResolution;
    }

    // Dimensions
    context.width = media.width;
    context.height = media.height;
    context.aspectRatio = media.aspectRatio;

    // Video specs (from Media level)
    context.videoCodec = media.videoCodec;
    context.videoProfile = media.videoProfile;
    context.videoFrameRate = media.videoFrameRate;

    // Audio specs (from Media level)
    context.audioCodec = media.audioCodec;
    context.audioChannels = media.audioChannels;

    // File info
    context.container = media.container;
    context.bitrate = media.bitrate;

    // Extract file path and size from Part (independent of Stream data)
    if (media.Part?.[0]) {
      if (media.Part[0].file) {
        context.filePath = media.Part[0].file;
      }
      if (media.Part[0].size) {
        context.fileSize = media.Part[0].size;
      }
    }

    // Extract detailed info from Streams
    if (media.Part?.[0]?.Stream) {
      const streams = media.Part[0].Stream;

      // Find video stream (streamType 1)
      const videoStream = streams.find((s) => s.streamType === 1);
      if (videoStream) {
        // HDR/Dolby Vision detection
        context.dolbyVision = videoStream.DOVIPresent || false;

        // Dolby Vision Profile (5, 7, 8, etc.)
        if (videoStream.DOVIProfile !== undefined) {
          context.dolbyVisionProfile = videoStream.DOVIProfile;
        }

        // Check for HDR in color transfer characteristic
        context.hdr =
          videoStream.colorTrc?.toLowerCase().includes('smpte2084') ||
          videoStream.colorTrc?.toLowerCase().includes('arib') ||
          false;

        // Color transfer characteristic (for distinguishing HDR10 vs HLG, etc.)
        if (videoStream.colorTrc) {
          context.colorTrc = videoStream.colorTrc;
        }

        // Parse bitDepth as number (Plex returns it as string)
        if (videoStream.bitDepth) {
          context.bitDepth = parseInt(String(videoStream.bitDepth), 10);
        }
      }
      // Find all audio streams (streamType 2)
      const audioStreams = streams.filter((s) => s.streamType === 2);
      if (audioStreams.length > 0) {
        // Primary audio stream (first one)
        const primaryAudio = audioStreams[0];

        // Detailed audio format from displayTitle
        if (primaryAudio.displayTitle) {
          context.audioFormat = primaryAudio.displayTitle;
        }
        // Audio channel layout
        if (primaryAudio.audioChannelLayout) {
          context.audioChannelLayout = primaryAudio.audioChannelLayout;
        }
        if (primaryAudio.channels) {
          context.audioChannels = primaryAudio.channels;
        }

        // Primary audio language
        if (primaryAudio.languageCode) {
          context.audioLanguageCode = primaryAudio.languageCode;
          context.audioLanguage = resolveLanguageName(
            primaryAudio.languageCode,
            primaryAudio.language ?? primaryAudio.languageCode
          );
        } else if (primaryAudio.language) {
          context.audioLanguage = primaryAudio.language;
        }

        // Collect all audio track languages (unique values only)
        const allAudioLanguageCodes = audioStreams
          .map((s) => s.languageCode)
          .filter((code): code is string => !!code);

        const allAudioLanguages =
          allAudioLanguageCodes.length > 0
            ? allAudioLanguageCodes.map((code) =>
                resolveLanguageName(code, code)
              )
            : audioStreams
                .map((s) => s.language)
                .filter((lang): lang is string => !!lang);

        if (allAudioLanguages.length > 0) {
          context.audioLanguages = [...new Set(allAudioLanguages)];
        }
        if (allAudioLanguageCodes.length > 0) {
          context.audioLanguageCodes = [...new Set(allAudioLanguageCodes)];
        }
      }

      // Find all subtitle streams (streamType 3)
      const subtitleStreams = streams.filter((s) => s.streamType === 3);
      context.hasSubtitles = subtitleStreams.length > 0;

      if (subtitleStreams.length > 0) {
        // Collect all subtitle languages (unique values only)
        const allSubtitleLanguageCodes = subtitleStreams
          .map((s) => s.languageCode)
          .filter((code): code is string => !!code);

        const allSubtitleLanguages =
          allSubtitleLanguageCodes.length > 0
            ? allSubtitleLanguageCodes.map((code) =>
                resolveLanguageName(code, code)
              )
            : subtitleStreams
                .map((s) => s.language)
                .filter((lang): lang is string => !!lang);

        if (allSubtitleLanguages.length > 0) {
          context.subtitleLanguages = [...new Set(allSubtitleLanguages)];
        }
        if (allSubtitleLanguageCodes.length > 0) {
          context.subtitleLanguageCodes = [
            ...new Set(allSubtitleLanguageCodes),
          ];
        }
      }
    }
  }

  // Playback stats and dates
  if (item.viewCount !== undefined) {
    context.viewCount = item.viewCount;
  }
  if (item.lastViewedAt) {
    context.lastPlayed = new Date(item.lastViewedAt * 1000);
    // Calculate days since last played
    const daysSinceLastPlayed = Math.floor(
      (Date.now() - item.lastViewedAt * 1000) / (1000 * 60 * 60 * 24)
    );
    context.daysSinceLastPlayed = daysSinceLastPlayed;
  }
  if (item.addedAt) {
    context.dateAdded = new Date(item.addedAt * 1000);
    // Calculate days since added
    const daysSinceAdded = Math.floor(
      (Date.now() - item.addedAt * 1000) / (1000 * 60 * 60 * 24)
    );
    context.daysSinceAdded = daysSinceAdded;
  }

  // TV-specific
  if (mediaType === 'show') {
    if (item.childCount !== undefined) {
      context.seasonsAvailable = item.childCount;
    }

    // For episode-level items, use parentIndex for season
    // For show-level items (placeholders/shows), parentIndex is undefined
    if (item.parentIndex !== undefined) {
      context.seasonNumber = item.parentIndex;
    }

    if (item.index !== undefined) {
      context.episodeNumber = item.index;
    }
  }

  // Plex Labels - extract item-level tags
  if (item.Label && Array.isArray(item.Label)) {
    context.plexLabels = item.Label.map((l) => l.tag).filter(
      (tag): tag is string => !!tag
    );
  }

  // Maintainerr integration - calculate daysUntilAction via the shared predicate
  // (single source of truth so the render context and the season subpass
  // active-set cannot drift).
  if (
    item.ratingKey &&
    maintainerrCollections &&
    maintainerrCollections.length > 0
  ) {
    try {
      const selected = computeDaysUntilAction(
        maintainerrCollections,
        item.ratingKey,
        {
          mediaType,
          tmdbId,
          seasonFallback,
          // Plex counts Specials in childCount, which is what 'all' needs: the
          // show only leaves once every season including season 0 does. Read
          // from the item itself so it cannot disagree with seasonsAvailable.
          // Absent on a season item, where 'all' has no meaning anyway.
          totalSeasons: item.type === 'show' ? item.childCount : undefined,
        }
      );

      if (selected) {
        context.daysUntilAction = selected.days;

        if (selected.childItemsMatched > 0) {
          context.seasonsLeavingCount = selected.childItemsMatched;
        }

        logger.debug('Calculated Maintainerr daysUntilAction', {
          label: 'OverlayContextBuilder',
          ratingKey: item.ratingKey,
          title: item.title,
          childItemsMatched: selected.childItemsMatched,
          selectedCollection: selected.collection.title,
          daysUntilAction: selected.days,
        });
      }
    } catch (error) {
      logger.debug('Failed to calculate Maintainerr daysUntilAction', {
        label: 'OverlayContextBuilder',
        ratingKey: item.ratingKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { context, criticalApiFailed };
}

/**
 * Release date info returned by fetchReleaseDateInfo
 */
export interface ReleaseDateInfo {
  releaseDate?: string;
  // releaseDate is the theatrical+90 guess, not a published digital/physical date.
  isEstimated?: boolean;
  nextEpisodeAirDate?: string;
  nextSeasonAirDate?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  tvdbId?: number;
}

type SonarrNextEpisode = {
  nextEpisodeAirDate: string;
  nextSeasonAirDate?: string;
  seasonNumber: number;
  episodeNumber: number;
};

/**
 * Discriminated Sonarr lookup result so callers can tell three cases apart
 * instead of collapsing them to null (fork#35 Mechanism 2):
 *  - 'found':  Sonarr has an upcoming episode for this series.
 *  - 'none':   a responding Sonarr instance has the series with nothing
 *              upcoming, or the series is not in Sonarr at all - an
 *              authoritative "nothing to count down to".
 *  - 'failed': every Sonarr instance that might have answered threw, so the
 *              answer is UNKNOWN. Callers must not read this as "no upcoming
 *              episode" - a transient outage would otherwise strip a countdown.
 */
type SonarrNextEpisodeResult =
  | { kind: 'found'; episode: SonarrNextEpisode }
  | { kind: 'none' }
  | { kind: 'failed' };

/**
 * Whether a resolved record carries a next-episode date that is still upcoming.
 * Used to decide when a Sonarr failure must skip the item rather than let
 * read-time clearing strip the overlay on a blip.
 */
function hasUpcomingNextEpisode(info: ReleaseDateInfo | undefined): boolean {
  if (!info?.nextEpisodeAirDate) return false;
  return isAirDateUpcoming(info.nextEpisodeAirDate);
}

/**
 * Fetch release date information from TMDB with Sonarr fallback for TV shows
 * For movies: Gets digital/physical/theatrical release dates
 * For TV: Gets next episode air date from TMDB, falls back to Sonarr if unavailable
 *
 * @param tmdbId - TMDB ID of the item
 * @param mediaType - Media type ('movie' or 'show')
 * @param sonarrCache - Optional cache for Sonarr series data (for performance)
 * @param preloadedTmdbReleaseDates - Optional preloaded release dates from batch prefetch
 * @param fetchStatus - Optional out-param set to { failed: true } only when the
 *   live fetch throws (a transient TMDB/Sonarr error), distinguishing it from a
 *   successful "no upcoming date exists" result which also returns undefined.
 *   Callers use this to skip overlay application instead of stripping a
 *   date-driven overlay with incomplete data (fork#35 Mechanism 2).
 */
export async function fetchReleaseDateInfo(
  tmdbId: number,
  mediaType: 'movie' | 'show',
  sonarrCache?: Map<string, SonarrSeries[]>,
  preloadedTmdbReleaseDates?: Map<string, ReleaseDateInfo | null>,
  fetchStatus?: { failed: boolean }
): Promise<ReleaseDateInfo | undefined> {
  // Check preloaded data first (batch prefetch optimization)
  if (preloadedTmdbReleaseDates) {
    const cacheKey = `${tmdbId}:${mediaType}`;
    const preloaded = preloadedTmdbReleaseDates.get(cacheKey);
    if (preloaded !== undefined) {
      logger.debug('Using preloaded TMDB release date', {
        label: 'OverlayContextBuilder',
        tmdbId,
        mediaType,
        hasData: preloaded !== null,
      });
      if (!preloaded) return undefined;

      // Sonarr-first: let Sonarr override the volatile next-episode fields on the
      // preloaded (TMDB-derived) record. This keeps the prefetch's avoided-fetch
      // optimisation while making Sonarr the freshness authority, and subsumes
      // the old date-only "enhance with Sonarr air time" path (fork#35).
      //
      // Guarded because this branch runs BEFORE the main try below: an
      // unexpected throw here (as the Intl.DateTimeFormat polyfill regression
      // did) would otherwise escape fetchReleaseDateInfo uncaught, bypassing the
      // Mechanism-2 skip-guard and surfacing as a generic per-item error instead
      // of a preserved overlay. Treat any throw as a transient failure.
      try {
        const { info, sonarrFailed } = await applySonarrFirstNextEpisode(
          preloaded,
          preloaded.tvdbId,
          sonarrCache
        );
        if (sonarrFailed && fetchStatus && !hasUpcomingNextEpisode(info)) {
          // Sonarr blipped and no source has an upcoming date: skip rather than
          // let read-time clearing strip the overlay on a transient outage.
          fetchStatus.failed = true;
        }
        return info;
      } catch (error) {
        if (fetchStatus) {
          fetchStatus.failed = true;
        }
        // warn, not debug: the throwable surface here is only the pure date
        // helpers (fetchNextEpisodeFromSonarr catches its own errors), so a
        // throw is unexpected and would be a fork#35-class regression - surface
        // it above debug spam even though the overlay is safely preserved.
        logger.warn(
          'Unexpected error applying Sonarr-first to preloaded release date',
          {
            label: 'OverlayContextBuilder',
            tmdbId,
            mediaType,
            error: error instanceof Error ? error.message : String(error),
          }
        );
        return undefined;
      }
    }
  }

  try {
    const tmdbClient = new TheMovieDb();

    if (mediaType === 'movie') {
      const movieDetails = await tmdbClient.getMovie({ movieId: tmdbId });

      // For movies, use proper release date calculation (digital > physical > theatrical+90)
      // This matches PlaceholderContextService implementation
      if (movieDetails.release_dates?.results) {
        const { extractReleaseDates, determineReleaseDate } = await import(
          '@server/utils/dateHelpers'
        );
        const preferredRegion =
          getSettings().overlays?.watchProviderRegion || 'US';
        const extracted = extractReleaseDates(
          movieDetails.release_dates.results,
          preferredRegion
        );

        const determined = determineReleaseDate(
          extracted.digitalRelease,
          extracted.physicalRelease,
          extracted.inCinemas
        );

        if (determined) {
          return {
            releaseDate: determined.releaseDate,
            isEstimated: determined.isEstimated,
          };
        }
      }

      // Fallback to simple release_date if release_dates not available
      if (movieDetails.release_date) {
        // Published date, not the +90 guess, so the flag is false rather than
        // absent: an `isEstimatedReleaseDate == false` condition cannot match an
        // undefined field (evaluateRule).
        return {
          releaseDate: movieDetails.release_date,
          isEstimated: false,
        };
      }
    } else {
      // For TV shows
      const showDetails = await tmdbClient.getTvShow({ tvId: tmdbId });
      const tvdbId = showDetails.external_ids?.tvdb_id;
      const nextEpisode = showDetails.next_episode_to_air;

      // Build the TMDB-derived next-episode candidate (may be empty).
      const tmdbBase: ReleaseDateInfo = {
        releaseDate: showDetails.first_air_date || undefined,
        tvdbId,
      };
      if (nextEpisode?.air_date) {
        tmdbBase.releaseDate =
          showDetails.first_air_date || nextEpisode.air_date;
        tmdbBase.nextEpisodeAirDate = nextEpisode.air_date;
        tmdbBase.seasonNumber = nextEpisode.season_number;
        tmdbBase.episodeNumber = nextEpisode.episode_number;
        tmdbBase.nextSeasonAirDate =
          nextEpisode.episode_number === 1 ? nextEpisode.air_date : undefined;
      }

      // Sonarr-first: Sonarr's nextAiring + numbering wins when it tracks the
      // show; TMDB is kept otherwise. This subsumes the old date-only "enhance
      // with Sonarr air time" path and the separate Sonarr fallback into one
      // authority (fork#35).
      const { info, sonarrFailed } = await applySonarrFirstNextEpisode(
        tmdbBase,
        tvdbId,
        sonarrCache
      );

      let result: ReleaseDateInfo | undefined;
      if (info.nextEpisodeAirDate) {
        result = info;
      } else if (showDetails.seasons && showDetails.seasons.length > 0) {
        // Shows in Plex but not tracked in Sonarr / not yet in next_episode:
        // use the earliest upcoming TMDB season air date as a premiere.
        const { isDateInFuture } = await import('@server/utils/dateHelpers');
        const sortedSeasons = [...showDetails.seasons]
          .filter((s) => s.season_number > 0) // Exclude specials
          .sort((a, b) => a.season_number - b.season_number);
        for (const season of sortedSeasons) {
          if (season.air_date && isDateInFuture(season.air_date)) {
            logger.debug('Using TMDB seasons fallback for next season data', {
              label: 'OverlayContextBuilder',
              tmdbId,
              seasonNumber: season.season_number,
              airDate: season.air_date,
            });
            result = {
              releaseDate: showDetails.first_air_date || season.air_date,
              nextEpisodeAirDate: season.air_date,
              // Season air date = episode 1 air date, so this is a premiere.
              nextSeasonAirDate: season.air_date,
              seasonNumber: season.season_number,
              episodeNumber: 1,
            };
            break;
          }
        }
      }

      // Fall back to first_air_date when nothing upcoming was found.
      if (!result && showDetails.first_air_date) {
        result = { releaseDate: showDetails.first_air_date };
      }

      // A Sonarr failure that left us without an upcoming next episode must skip
      // the item (keep the last poster) rather than clear the countdown on a
      // transient outage - the fork#35 Mechanism-2 guard.
      if (sonarrFailed && fetchStatus && !hasUpcomingNextEpisode(result)) {
        fetchStatus.failed = true;
      }

      return result;
    }

    return undefined;
  } catch (error) {
    // fork#35 (Mechanism 2): a transient failure here is NOT the same as "no
    // upcoming date exists" - both return undefined, but only this one should
    // make the caller skip the item rather than strip a date-driven overlay.
    if (fetchStatus) {
      fetchStatus.failed = true;
    }
    logger.debug('Failed to fetch release date info', {
      label: 'OverlayContextBuilder',
      tmdbId,
      mediaType,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Fetch next episode information from Sonarr as fallback when TMDB is incomplete
 * Uses Sonarr's calendar data to find the next upcoming episode
 */
export async function fetchNextEpisodeFromSonarr(
  tvdbId: number,
  cache?: Map<string, SonarrSeries[]>
): Promise<SonarrNextEpisodeResult> {
  try {
    const settings = getSettings();

    if (!settings.sonarr || settings.sonarr.length === 0) {
      return { kind: 'none' };
    }

    // Any instance that errors leaves the aggregate answer UNKNOWN: unless some
    // instance returned a 'found', a failure must not be reported as 'none',
    // because a failed instance could be the one holding the upcoming episode.
    let anyInstanceFailed = false;

    // Check each Sonarr instance
    for (const sonarrSettings of settings.sonarr) {
      if (!sonarrSettings.hostname) {
        continue;
      }

      try {
        const allSeries = await getSonarrSeries(sonarrSettings, cache);
        const series = allSeries.find((s) => s.tvdbId === tvdbId);

        if (series && series.nextAiring) {
          // Series has upcoming episode - find which season it belongs to
          // Match by finding the season whose statistics.nextAiring matches series.nextAiring
          let nextSeasonNumber = 1;
          let nextEpisodeNumber = 1;

          if (series.seasons && series.seasons.length > 0) {
            // First, try to find season whose nextAiring matches series.nextAiring exactly
            const matchingSeason = series.seasons.find(
              (s) =>
                s.monitored &&
                s.seasonNumber > 0 &&
                s.statistics?.nextAiring === series.nextAiring
            );

            if (matchingSeason) {
              nextSeasonNumber = matchingSeason.seasonNumber;
              const stats = matchingSeason.statistics;
              // Episode number: if no files downloaded, it's episode 1 (season premiere)
              // Otherwise, next episode is files + 1 (approximation for overlay purposes)
              nextEpisodeNumber = stats ? (stats.episodeFileCount || 0) + 1 : 1;
            } else {
              // Fallback: find the latest monitored season with upcoming content
              // Sort by season number ascending to find earliest upcoming season
              const monitoredSeasons = series.seasons
                .filter((s) => s.monitored && s.seasonNumber > 0)
                .sort((a, b) => a.seasonNumber - b.seasonNumber);

              for (const season of monitoredSeasons) {
                const stats = season.statistics;
                // A season is "upcoming" if it has a nextAiring date
                // (handles both new seasons with 0 episodes and mid-season)
                if (stats?.nextAiring) {
                  nextSeasonNumber = season.seasonNumber;
                  nextEpisodeNumber = (stats.episodeFileCount || 0) + 1;
                  break;
                }
                // Also handle new seasons without episode counts yet
                if (
                  stats &&
                  stats.totalEpisodeCount === 0 &&
                  stats.episodeFileCount === 0
                ) {
                  // New season with no episodes yet - assume episode 1
                  nextSeasonNumber = season.seasonNumber;
                  nextEpisodeNumber = 1;
                  // Don't break - keep looking for one with nextAiring
                }
              }
            }
          }

          // nextSeasonAirDate is ONLY for season premieres (episode 1)
          const nextSeasonAirDate =
            nextEpisodeNumber === 1 ? series.nextAiring : undefined;

          // Only an UPCOMING nextAiring is authoritative. A stale/past nextAiring
          // (Sonarr not yet advanced past a just-aired episode) must not shadow
          // another instance that holds the real upcoming episode, so keep
          // looking rather than returning it.
          if (isAirDateUpcoming(series.nextAiring)) {
            return {
              kind: 'found',
              episode: {
                nextEpisodeAirDate: series.nextAiring,
                nextSeasonAirDate,
                seasonNumber: nextSeasonNumber,
                episodeNumber: nextEpisodeNumber,
              },
            };
          }
        }
        // A responding instance without the series, with no upcoming episode, or
        // with only a stale/past nextAiring, is 'nothing next' for that instance
        // - no bookkeeping needed; it only matters that no instance FAILED
        // (checked below).
      } catch (error) {
        anyInstanceFailed = true;
        logger.debug('Failed to check Sonarr instance for next episode', {
          label: 'OverlayContextBuilder',
          hostname: sonarrSettings.hostname,
          tvdbId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }

    // No instance returned a 'found'. If any instance errored, the answer is
    // unknown ('failed') - a failed instance could hold the upcoming episode, so
    // reporting 'none' here would strip a countdown on a transient outage
    // (fork#35 Mechanism 2). Only when every instance responded is 'none'
    // authoritative.
    return anyInstanceFailed ? { kind: 'failed' } : { kind: 'none' };
  } catch (error) {
    logger.debug('Failed to fetch next episode from Sonarr', {
      label: 'OverlayContextBuilder',
      tvdbId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: 'failed' };
  }
}

/**
 * Pure Sonarr-first resolution of the volatile next-episode fields (fork#35),
 * given an already-fetched Sonarr result.
 *
 * TMDB's `next_episode_to_air` lags reality (gateway cache + TMDB's data
 * pipeline) and can report a just-aired episode for hours - the flip-flop
 * source. Sonarr is LAN-local and advances `nextAiring` at airtime, so it is
 * the freshness authority when it tracks the show. But only when Sonarr's own
 * date is still UPCOMING: a stale Sonarr database can report a PAST nextAiring,
 * which must never overwrite a valid future TMDB date.
 *
 *  - found + upcoming -> Sonarr's date + numbering win (also fixes anime
 *    absolute numbering). Wins even on a >2d disagreement with TMDB - that is
 *    exactly the stale-TMDB case the fix targets.
 *  - found + already past -> Sonarr is stale; keep TMDB's candidate.
 *  - failed -> keep TMDB but report `sonarrFailed` so the caller can skip when
 *    no source yields an upcoming date (skip beats stripping on a blip).
 *  - none -> authoritative empty (or not in Sonarr); keep TMDB and let the
 *    read-time derivation clear a passed date.
 */
export function resolveSonarrFirstNextEpisode(
  base: ReleaseDateInfo,
  sonarr: SonarrNextEpisodeResult
): { info: ReleaseDateInfo; sonarrFailed: boolean } {
  if (
    sonarr.kind === 'found' &&
    isAirDateUpcoming(sonarr.episode.nextEpisodeAirDate)
  ) {
    const ep = sonarr.episode;
    return {
      info: {
        ...base,
        releaseDate: base.releaseDate || ep.nextEpisodeAirDate,
        nextEpisodeAirDate: ep.nextEpisodeAirDate,
        nextSeasonAirDate: ep.nextSeasonAirDate,
        seasonNumber: ep.seasonNumber,
        episodeNumber: ep.episodeNumber,
      },
      sonarrFailed: false,
    };
  }

  // found-but-past (stale Sonarr) or none: keep TMDB. failed: keep TMDB but flag
  // it so the caller skips only when nothing upcoming exists from any source.
  return { info: base, sonarrFailed: sonarr.kind === 'failed' };
}

/**
 * I/O wrapper: fetch the Sonarr next episode for a show and apply
 * {@link resolveSonarrFirstNextEpisode}. Logs a large TMDB/Sonarr disagreement
 * (when Sonarr wins) so a persistent mismatch - e.g. a wrong TVDB numbering map
 * - is discoverable rather than silent.
 */
async function applySonarrFirstNextEpisode(
  base: ReleaseDateInfo,
  tvdbId: number | undefined,
  sonarrCache?: Map<string, SonarrSeries[]>
): Promise<{ info: ReleaseDateInfo; sonarrFailed: boolean }> {
  if (!tvdbId) {
    return { info: base, sonarrFailed: false };
  }

  const sonarr = await fetchNextEpisodeFromSonarr(tvdbId, sonarrCache);

  if (
    sonarr.kind === 'found' &&
    base.nextEpisodeAirDate &&
    isAirDateUpcoming(sonarr.episode.nextEpisodeAirDate)
  ) {
    const tmdbDay = toServerCalendarDate(base.nextEpisodeAirDate);
    const sonarrDay = toServerCalendarDate(sonarr.episode.nextEpisodeAirDate);
    const daysDiff =
      Math.abs(new Date(tmdbDay).getTime() - new Date(sonarrDay).getTime()) /
      (1000 * 60 * 60 * 24);
    if (daysDiff > 2) {
      logger.warn(
        'Sonarr and TMDB disagree on next episode date by >2d; using Sonarr (freshness authority)',
        {
          label: 'OverlayContextBuilder',
          tvdbId,
          tmdbDate: base.nextEpisodeAirDate,
          sonarrDate: sonarr.episode.nextEpisodeAirDate,
        }
      );
    }
  }

  return resolveSonarrFirstNextEpisode(base, sonarr);
}

/**
 * Check monitoring status in Radarr/Sonarr
 * Returns whether item exists in *arr and if it's monitored (series-level)
 *
 * @param tmdbId - TMDB ID of the item
 * @param mediaType - Media type ('movie' or 'show')
 * @param radarrCache - Optional cache for Radarr movie data
 * @param sonarrCache - Optional cache for Sonarr series data
 */
export async function checkMonitoringStatus(
  tmdbId: number,
  mediaType: 'movie' | 'show',
  radarrCache?: Map<string, RadarrMovie[]>,
  sonarrCache?: Map<string, SonarrSeries[]>
): Promise<{
  inRadarr?: boolean;
  inSonarr?: boolean;
  isMonitored?: boolean;
  hasFile?: boolean;
  radarrTags?: string[];
  sonarrTags?: string[];
}> {
  try {
    const settings = getSettings();

    if (
      mediaType === 'movie' &&
      settings.radarr &&
      settings.radarr.length > 0
    ) {
      // Check Radarr for movies
      for (const radarrSettings of settings.radarr) {
        if (!radarrSettings.hostname) {
          continue;
        }

        try {
          const movies = await getRadarrMovies(radarrSettings, radarrCache);
          const movie = movies.find((m) => m.tmdbId === tmdbId);

          if (movie) {
            // Fetch tags if movie has any
            let tagNames: string[] = [];
            if (movie.tags && movie.tags.length > 0) {
              try {
                const RadarrAPI = (await import('@server/api/servarr/radarr'))
                  .default;
                const radarr = new RadarrAPI({
                  url: `${radarrSettings.useSsl ? 'https' : 'http'}://${
                    radarrSettings.hostname
                  }:${radarrSettings.port}${
                    radarrSettings.baseUrl || ''
                  }/api/v3`,
                  apiKey: radarrSettings.apiKey,
                });
                const allTags = await radarr.getTags();
                tagNames = movie.tags
                  .map((tagId) => allTags.find((t) => t.id === tagId)?.label)
                  .filter((label): label is string => label !== undefined);
              } catch (tagError) {
                logger.debug('Failed to fetch Radarr tags', {
                  label: 'OverlayContextBuilder',
                  error:
                    tagError instanceof Error
                      ? tagError.message
                      : String(tagError),
                });
              }
            }

            logger.debug('Found movie in Radarr', {
              label: 'OverlayContextBuilder',
              tmdbId,
              monitored: movie.monitored,
              hasFile: movie.hasFile,
              tags: tagNames,
            });
            return {
              inRadarr: true,
              isMonitored: movie.monitored,
              hasFile: movie.hasFile,
              radarrTags: tagNames.length > 0 ? tagNames : undefined,
            };
          }
        } catch (error) {
          logger.debug('Failed to check Radarr instance', {
            label: 'OverlayContextBuilder',
            hostname: radarrSettings.hostname,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      }

      return { inRadarr: false, isMonitored: false };
    } else if (
      mediaType === 'show' &&
      settings.sonarr &&
      settings.sonarr.length > 0
    ) {
      // Check Sonarr for TV shows - prefer TVDB ID, fallback to title match
      const tvdbId = await getTvdbIdFromTmdb(tmdbId);

      // Get title from TMDB for fallback matching
      let tmdbTitle: string | undefined;
      if (!tvdbId) {
        try {
          const tmdbClient = new TheMovieDb();
          const showDetails = await tmdbClient.getTvShow({ tvId: tmdbId });
          tmdbTitle = showDetails.name || showDetails.original_name;
        } catch {
          // Ignore errors, just won't have title fallback
        }
      }

      for (const sonarrSettings of settings.sonarr) {
        if (!sonarrSettings.hostname) {
          continue;
        }

        try {
          const allSeries = await getSonarrSeries(sonarrSettings, sonarrCache);
          let series;

          // Try TVDB ID first if available
          if (tvdbId) {
            series = allSeries.find((s) => s.tvdbId === tvdbId);
          }

          // Fallback to title match if no TVDB ID or not found
          if (!series && tmdbTitle) {
            const normalizedTmdbTitle = tmdbTitle.toLowerCase();
            const normalizedTmdbTitleNoSpecial = normalizedTmdbTitle.replace(
              /[^\w\s]/g,
              ''
            );
            series = allSeries.find(
              (s) =>
                s.title.toLowerCase() === normalizedTmdbTitle ||
                s.title.toLowerCase().replace(/[^\w\s]/g, '') ===
                  normalizedTmdbTitleNoSpecial
            );
          }

          if (series) {
            const hasFile = (series.statistics?.episodeFileCount || 0) > 0;

            // Fetch tags if series has any
            let tagNames: string[] = [];
            if (series.tags && series.tags.length > 0) {
              try {
                const SonarrAPI = (await import('@server/api/servarr/sonarr'))
                  .default;
                const sonarr = new SonarrAPI({
                  url: `${sonarrSettings.useSsl ? 'https' : 'http'}://${
                    sonarrSettings.hostname
                  }:${sonarrSettings.port}${
                    sonarrSettings.baseUrl || ''
                  }/api/v3`,
                  apiKey: sonarrSettings.apiKey,
                });
                const allTags = await sonarr.getTags();
                tagNames = series.tags
                  .map((tagId) => allTags.find((t) => t.id === tagId)?.label)
                  .filter((label): label is string => label !== undefined);
              } catch (tagError) {
                logger.debug('Failed to fetch Sonarr tags', {
                  label: 'OverlayContextBuilder',
                  error:
                    tagError instanceof Error
                      ? tagError.message
                      : String(tagError),
                });
              }
            }

            logger.debug('Found series in Sonarr', {
              label: 'OverlayContextBuilder',
              tmdbId,
              tvdbId,
              tmdbTitle,
              sonarrTitle: series.title,
              matchedBy:
                tvdbId && series.tvdbId === tvdbId ? 'tvdbId' : 'title',
              monitored: series.monitored,
              episodeFileCount: series.statistics?.episodeFileCount,
              hasFile,
              tags: tagNames,
            });

            return {
              inSonarr: true,
              isMonitored: series.monitored,
              hasFile,
              sonarrTags: tagNames.length > 0 ? tagNames : undefined,
            };
          }
        } catch (error) {
          logger.debug('Failed to check Sonarr instance', {
            label: 'OverlayContextBuilder',
            hostname: sonarrSettings.hostname,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      }

      return { inSonarr: false, isMonitored: false };
    }

    return {};
  } catch (error) {
    logger.debug('Failed to check monitoring status', {
      label: 'OverlayContextBuilder',
      mediaType,
      tmdbId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

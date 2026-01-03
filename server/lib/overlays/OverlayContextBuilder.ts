import ImdbAPI from '@server/api/imdb';
import ImdbRatingsAPI from '@server/api/imdbRatings';
import type { MaintainerrCollection } from '@server/api/maintainerr';
import type { PlexLibraryItem } from '@server/api/plexapi';
import RottenTomatoes, { type RTRating } from '@server/api/rottentomatoes';
import type { RadarrMovie } from '@server/api/servarr/radarr';
import type { SonarrSeries } from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import cacheManager from '@server/lib/cache';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { OverlayRenderContext } from './OverlayTemplateRenderer';

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

/**
 * Calculate adaptive TTL for rating caches based on content age.
 * Older content has more stable ratings, so cache longer.
 */
function getAdaptiveTtl(releaseYear: number | undefined): number {
  if (!releaseYear) {
    return 3 * 24 * 60 * 60; // 3 days default if unknown
  }

  const currentYear = new Date().getFullYear();
  const age = currentYear - releaseYear;

  if (age < 1) {
    return 12 * 60 * 60; // 12 hours for new releases
  }
  if (age < 2) {
    return 3 * 24 * 60 * 60; // 3 days for recent content
  }
  if (age < 10) {
    return 7 * 24 * 60 * 60; // 7 days for older content
  }
  return 30 * 24 * 60 * 60; // 30 days for archive content
}

/**
 * Get adaptive TTL for null (no rating) results.
 * Shorter for new/upcoming content (ratings may appear soon),
 * longer for old content (unlikely to get ratings now).
 */
function getNullRatingTtl(releaseYear: number | undefined): number {
  if (!releaseYear) {
    return 6 * 60 * 60; // 6 hours default
  }

  const currentYear = new Date().getFullYear();
  const age = currentYear - releaseYear;

  if (age < 0) {
    return 2 * 60 * 60; // 2 hours for upcoming (ratings may appear at release)
  }
  if (age < 1) {
    return 4 * 60 * 60; // 4 hours for new releases
  }
  if (age < 2) {
    return 12 * 60 * 60; // 12 hours for recent
  }
  return 24 * 60 * 60; // 24 hours for older (unlikely to get new ratings)
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
 * @returns Object containing the context and a flag indicating if critical APIs failed.
 *          When criticalApiFailed is true, callers should skip overlay application
 *          to avoid regenerating posters with incomplete data.
 */
export async function buildRenderContext(
  item: PlexLibraryItem,
  mediaType: 'movie' | 'show',
  isPlaceholder = false,
  maintainerrCollections?: MaintainerrCollection[],
  preloadedImdbRatings?: Map<string, number | null>,
  requiredContextFields?: Set<string>
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

        // IMDb Top 250 check
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

      // Rotten Tomatoes ratings - skip if no template uses RT fields
      const needsRtRatings =
        !requiredContextFields ||
        requiredContextFields.has('rtCriticsScore') ||
        requiredContextFields.has('rtAudienceScore');

      if (needsRtRatings && tmdbId) {
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
            logger.debug('Using cached RT ratings', {
              label: 'OverlayContextBuilder',
              title: context.title,
              tmdbId,
              criticsScore: rtRating.criticsScore,
              audienceScore: rtRating.audienceScore,
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
                    context.title || '',
                    context.year || 0
                  )
                : await rtClient.getTVRatings(
                    context.title || '',
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
                // Cache the rating with adaptive TTL
                rtCache.data.set(rtCacheKey, rtRating, ttl);
                logger.debug('Fetched and cached RT ratings', {
                  label: 'OverlayContextBuilder',
                  title: context.title,
                  tmdbId,
                  criticsScore: rtRating.criticsScore,
                  audienceScore: rtRating.audienceScore,
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
      } else if (
        mediaType === 'show' &&
        'episode_run_time' in tmdbData &&
        tmdbData.episode_run_time?.[0]
      ) {
        context.runtime = tmdbData.episode_run_time[0];
      }

      // TMDB Status (TV shows only) - using Kometa's user-friendly mapping
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
          logger.warn('IMDb rating fetch failed - marking as critical failure', {
            label: 'OverlayContextBuilder',
            imdbId,
            itemTitle: item.title,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // IMDb Top 250 check
      try {
        const imdbClient = getImdbClient();
        const imdbMediaType: 'movie' | 'tv' =
          mediaType === 'show' ? 'tv' : 'movie';
        const top250Result = await imdbClient.checkTop250(imdbId, imdbMediaType);

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

  // Plex-specific metadata from Media (skip for placeholder items)
  if (!isPlaceholder && item.Media?.[0]) {
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
      // Find audio stream (streamType 2) - prefer first one
      const audioStream = streams.find((s) => s.streamType === 2);
      if (audioStream) {
        // Detailed audio format from displayTitle
        if (audioStream.displayTitle) {
          context.audioFormat = audioStream.displayTitle;
        }
        // Audio channel layout
        if (audioStream.audioChannelLayout) {
          context.audioChannelLayout = audioStream.audioChannelLayout;
        }
        if (audioStream.channels) {
          context.audioChannels = audioStream.channels;
        }
      }

      // Get file path from Part
      if (media.Part[0].file) {
        context.filePath = media.Part[0].file;
      }
      // Get file size
      if (media.Part[0].size) {
        context.fileSize = media.Part[0].size;
      }
    }
  }

  // Playback stats and dates
  if (item.viewCount !== undefined) {
    context.viewCount = item.viewCount;
  }
  if (item.lastViewedAt) {
    context.lastPlayed = new Date(item.lastViewedAt * 1000);
  }
  if (item.addedAt) {
    context.dateAdded = new Date(item.addedAt * 1000);
  }

  // TV-specific
  if (mediaType === 'show') {
    // For episode-level items, use parentIndex for season
    // For show-level items (placeholders/shows), parentIndex is undefined
    if (item.parentIndex !== undefined) {
      context.seasonNumber = item.parentIndex;
    }

    if (item.index !== undefined) {
      context.episodeNumber = item.index;
    }
  }

  // Maintainerr integration - calculate daysUntilAction
  // Use cached collections if provided, otherwise fetch them
  if (
    item.ratingKey &&
    maintainerrCollections &&
    maintainerrCollections.length > 0
  ) {
    try {
      // Find ALL collections containing this item
      const matchingCollections: {
        collection: MaintainerrCollection;
        daysUntilAction: number;
      }[] = [];

      for (const collection of maintainerrCollections) {
        const mediaItem = collection.media.find(
          (m) => m.plexId === Number(item.ratingKey)
        );

        if (mediaItem && collection.deleteAfterDays) {
          // Calculate days since item was added to collection
          const addedDate = new Date(mediaItem.addDate);
          const now = new Date();
          const daysSinceAdded = Math.floor(
            (now.getTime() - addedDate.getTime()) / (1000 * 60 * 60 * 24)
          );

          // Calculate days until action: deleteAfterDays - daysSinceAdded
          // Positive = days remaining, negative = overdue
          const daysUntilAction = collection.deleteAfterDays - daysSinceAdded;

          matchingCollections.push({ collection, daysUntilAction });
        }
      }

      // If item is in multiple collections, use the one with LOWEST daysUntilAction
      if (matchingCollections.length > 0) {
        const selected = matchingCollections.reduce((min, curr) =>
          curr.daysUntilAction < min.daysUntilAction ? curr : min
        );

        context.daysUntilAction = selected.daysUntilAction;

        logger.debug('Calculated Maintainerr daysUntilAction', {
          label: 'OverlayContextBuilder',
          ratingKey: item.ratingKey,
          title: item.title,
          matchingCollections: matchingCollections.length,
          selectedCollection: selected.collection.title,
          daysUntilAction: selected.daysUntilAction,
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
 * Fetch release date information from TMDB with Sonarr fallback for TV shows
 * For movies: Gets digital/physical/theatrical release dates
 * For TV: Gets next episode air date from TMDB, falls back to Sonarr if unavailable
 *
 * @param tmdbId - TMDB ID of the item
 * @param mediaType - Media type ('movie' or 'show')
 * @param sonarrCache - Optional cache for Sonarr series data (for performance)
 */
export async function fetchReleaseDateInfo(
  tmdbId: number,
  mediaType: 'movie' | 'show',
  sonarrCache?: Map<string, SonarrSeries[]>
): Promise<
  | {
      releaseDate?: string;
      nextEpisodeAirDate?: string;
      nextSeasonAirDate?: string;
      seasonNumber?: number;
    }
  | undefined
> {
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
        const extracted = extractReleaseDates(
          movieDetails.release_dates.results
        );

        const determined = determineReleaseDate(
          extracted.digitalRelease,
          extracted.physicalRelease,
          extracted.inCinemas
        );

        if (determined) {
          return {
            releaseDate: determined.releaseDate,
          };
        }
      }

      // Fallback to simple release_date if release_dates not available
      if (movieDetails.release_date) {
        return {
          releaseDate: movieDetails.release_date,
        };
      }
    } else {
      // For TV shows
      const showDetails = await tmdbClient.getTvShow({ tvId: tmdbId });

      // Get next episode info from TMDB
      const nextEpisode = showDetails.next_episode_to_air;
      if (nextEpisode?.air_date) {
        const seasonNumber = nextEpisode.season_number;
        const episodeNumber = nextEpisode.episode_number;
        let airDate = nextEpisode.air_date;

        // If TMDB returns a date-only string (no time component), try to get
        // the precise air time from Sonarr for better timezone accuracy
        if (!airDate.includes('T')) {
          const tvdbId = showDetails.external_ids?.tvdb_id;
          if (tvdbId) {
            const sonarrResult = await fetchNextEpisodeFromSonarr(
              tvdbId,
              sonarrCache
            );
            // Use Sonarr's datetime if it matches the same date (within 2 days tolerance)
            if (sonarrResult?.nextEpisodeAirDate?.includes('T')) {
              const tmdbDate = airDate.split('T')[0];
              const sonarrDate = sonarrResult.nextEpisodeAirDate.split('T')[0];
              // Check if dates are close (Sonarr might have slightly different date due to timezone)
              const tmdbMs = new Date(tmdbDate).getTime();
              const sonarrMs = new Date(sonarrDate).getTime();
              const daysDiff =
                Math.abs(tmdbMs - sonarrMs) / (1000 * 60 * 60 * 24);
              if (daysDiff <= 2) {
                airDate = sonarrResult.nextEpisodeAirDate;
                logger.debug('Enhanced TMDB date with Sonarr air time', {
                  label: 'OverlayContextBuilder',
                  tmdbId,
                  originalDate: nextEpisode.air_date,
                  enhancedDate: airDate,
                });
              }
            }
          }
        }

        // nextSeasonAirDate is ONLY for season premieres (episode 1)
        const nextSeasonAirDate = episodeNumber === 1 ? airDate : undefined;

        return {
          releaseDate: showDetails.first_air_date || airDate,
          nextEpisodeAirDate: airDate,
          nextSeasonAirDate,
          seasonNumber,
        };
      }

      // TMDB doesn't have next_episode_to_air - try Sonarr fallback
      // This handles shows where TMDB data is incomplete but Sonarr has upcoming episodes
      const tvdbId = showDetails.external_ids?.tvdb_id;
      if (tvdbId) {
        const sonarrResult = await fetchNextEpisodeFromSonarr(
          tvdbId,
          sonarrCache
        );

        if (sonarrResult) {
          logger.debug('Using Sonarr fallback for next episode data', {
            label: 'OverlayContextBuilder',
            tmdbId,
            tvdbId,
            nextAiring: sonarrResult.nextEpisodeAirDate,
            seasonNumber: sonarrResult.seasonNumber,
            episodeNumber: sonarrResult.episodeNumber,
          });

          return {
            releaseDate:
              showDetails.first_air_date || sonarrResult.nextEpisodeAirDate,
            nextEpisodeAirDate: sonarrResult.nextEpisodeAirDate,
            nextSeasonAirDate: sonarrResult.nextSeasonAirDate,
            seasonNumber: sonarrResult.seasonNumber,
          };
        }
      }

      // Third fallback: Use TMDB seasons data for shows not in Sonarr
      // This handles shows that are in Plex but not monitored in Sonarr
      if (showDetails.seasons && showDetails.seasons.length > 0) {
        const { isDateInFuture } = await import('@server/utils/dateHelpers');

        // Sort seasons by number to find the earliest upcoming one
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

            return {
              releaseDate: showDetails.first_air_date || season.air_date,
              nextEpisodeAirDate: season.air_date,
              // Season air date = episode 1 air date, so this is a premiere
              nextSeasonAirDate: season.air_date,
              seasonNumber: season.season_number,
            };
          }
        }
      }

      // No next episode from any source, use first_air_date if available
      if (showDetails.first_air_date) {
        return {
          releaseDate: showDetails.first_air_date,
        };
      }
    }

    return undefined;
  } catch (error) {
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
async function fetchNextEpisodeFromSonarr(
  tvdbId: number,
  cache?: Map<string, SonarrSeries[]>
): Promise<{
  nextEpisodeAirDate: string;
  nextSeasonAirDate?: string;
  seasonNumber: number;
  episodeNumber: number;
} | null> {
  try {
    const settings = getSettings();

    if (!settings.sonarr || settings.sonarr.length === 0) {
      return null;
    }

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

          return {
            nextEpisodeAirDate: series.nextAiring,
            nextSeasonAirDate,
            seasonNumber: nextSeasonNumber,
            episodeNumber: nextEpisodeNumber,
          };
        }
      } catch (error) {
        logger.debug('Failed to check Sonarr instance for next episode', {
          label: 'OverlayContextBuilder',
          hostname: sonarrSettings.hostname,
          tvdbId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }

    return null;
  } catch (error) {
    logger.debug('Failed to fetch next episode from Sonarr', {
      label: 'OverlayContextBuilder',
      tvdbId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
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

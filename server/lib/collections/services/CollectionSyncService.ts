import OverseerrAPI, {
  type OverseerrMediaRequest,
} from '@server/api/overseerr';
import type PlexAPI from '@server/api/plexapi';
import collectionSyncProgress from '@server/lib/collections/CollectionSyncProgress';
import type { BaseCollectionSync } from '@server/lib/collections/core/BaseCollectionSync';
import type { LibraryItemsCache } from '@server/lib/collections/core/CollectionUtilities';
import { getCollectionMediaType } from '@server/lib/collections/core/CollectionUtilities';
import type {
  CollectionSource,
  SyncResult,
} from '@server/lib/collections/core/types';
import type {
  DiscoveredMoviePlaceholder,
  DiscoveredPlaceholder,
} from '@server/lib/placeholders/services/PlaceholderDiscovery';
import type {
  CollectionConfig,
  MultiSourceCollectionConfig,
  MultiSourceCombineMode,
  MultiSourceType,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import path from 'path';
import { syncCacheService } from './SyncCacheService';

/**
 * Service for orchestrating collection synchronization across all sources
 * Replaces the large switch statement in collectionsSync.ts with clean service calls
 */
export class CollectionSyncService {
  private cancelled = false;

  public cancel(): void {
    this.cancelled = true;
  }

  /**
   * Pre-fetch all Overseerr requests to avoid repeated API calls during sync
   * OPTIMIZATION: Call this ONCE and share the cache across all services
   */
  private async prefetchOverseerrRequests(): Promise<OverseerrMediaRequest[]> {
    try {
      const settings = getSettings();
      const overseerrSettings = settings.overseerr;

      // Only fetch if Overseerr is configured
      if (!overseerrSettings?.hostname || !overseerrSettings?.apiKey) {
        logger.debug('Overseerr not configured, skipping requests cache', {
          label: 'Collection Sync Service',
        });
        return [];
      }

      const overseerrAPI = new OverseerrAPI(overseerrSettings);

      logger.info('Pre-fetching all Overseerr requests for sync optimization', {
        label: 'Collection Sync Service',
      });

      // Fetch with a generous limit to get all requests
      const response = await overseerrAPI.getRequests({ take: 5000 });
      const requestCount = response.results.length;

      logger.info(
        `Overseerr requests cache ready (${requestCount} requests cached)`,
        {
          label: 'Collection Sync Service',
          cachedRequests: requestCount,
        }
      );

      return response.results;
    } catch (error) {
      logger.warn(
        `Failed to pre-fetch Overseerr requests, services will fall back to individual API calls: ${error}`,
        {
          label: 'Collection Sync Service',
          error: error instanceof Error ? error.message : String(error),
        }
      );
      return []; // Return empty array on error, services will handle fallback
    }
  }

  /**
   * Pre-fetch placeholder discovery to avoid repeated filesystem scans during sync
   * OPTIMIZATION: Run discovery ONCE per library and share results across all collections
   */
  private async prefetchPlaceholderDiscovery(
    plexClient: PlexAPI,
    collectionConfigs: CollectionConfig[],
    libraryCache?: LibraryItemsCache
  ): Promise<{
    tv: DiscoveredPlaceholder[];
    movies: DiscoveredMoviePlaceholder[];
  }> {
    const { getPlaceholderRootFolder } = await import(
      '@server/lib/placeholders/helpers/placeholderPathHelpers'
    );

    const tv: DiscoveredPlaceholder[] = [];
    const movies: DiscoveredMoviePlaceholder[] = [];

    // Only run discovery if there are collections with placeholders enabled
    const hasPlaceholderCollections = collectionConfigs.some(
      (c) => c.createPlaceholdersForMissing
    );

    if (!hasPlaceholderCollections) {
      logger.debug('No placeholder-enabled collections, skipping discovery', {
        label: 'Collection Sync Service',
      });
      return { tv, movies };
    }

    // Import discovery functions
    const {
      discoverPlaceholdersFromMarkers,
      discoverMoviePlaceholdersFromFilenames,
    } = await import('@server/lib/placeholders/services/PlaceholderDiscovery');

    // Collect all unique TV library IDs with placeholder-enabled collections
    const tvLibraryIds = [
      ...new Set(
        collectionConfigs
          .filter((c) => {
            if (!c.createPlaceholdersForMissing) return false;
            try {
              return getCollectionMediaType(c) === 'tv';
            } catch {
              return false;
            }
          })
          .map((c) => c.libraryId)
      ),
    ];

    if (tvLibraryIds.length > 0) {
      const { cleanupPlaceholderForRealContent, removeGhostEntries } =
        await import('@server/lib/placeholders/services/PlaceholderCleanup');
      const { ensurePlaceholderEpisodeTitle } = await import(
        '@server/lib/placeholders/services/PlaceholderTitleFixer'
      );

      for (const tvLibraryId of tvLibraryIds) {
        const tvLibraryPath = getPlaceholderRootFolder(tvLibraryId, 'tv');
        if (!tvLibraryPath) continue;

        try {
          logger.info('Running global TV placeholder discovery', {
            label: 'Collection Sync Service',
            libraryId: tvLibraryId,
            libraryPath: tvLibraryPath,
          });

          const discovered = await discoverPlaceholdersFromMarkers(
            plexClient,
            tvLibraryId,
            tvLibraryPath,
            libraryCache
          );

          logger.info('Global TV placeholder discovery complete', {
            label: 'Collection Sync Service',
            libraryId: tvLibraryId,
            discovered: discovered.length,
          });

          tv.push(...discovered);

          // Process discovered placeholders: apply labels, fix titles, cleanup real content
          let cleanedUp = 0;
          let labelsFixed = 0;
          let titlesFixes = 0;
          let titleFixFailures = 0;
          const cleanedFolders: string[] = [];

          for (const { plexItem, needsTitleFix, marker } of discovered) {
            // Cleanup triggers when needsTitleFix is false (real content detected via Plex OR *arr)
            // This works even without a plexItem (content downloaded to different library)
            if (!needsTitleFix && marker.tmdbId) {
              await cleanupPlaceholderForRealContent(
                marker.tmdbId,
                marker.placeholderPath,
                'tv',
                plexClient,
                plexItem?.ratingKey
              );
              cleanedUp++;
              // placeholderPath is <show>/Season 00/S00E00.Trailer.mp4 — scope
              // the ghost-entry scan to the show folder
              cleanedFolders.push(
                path.dirname(path.dirname(marker.placeholderPath))
              );
            } else if (needsTitleFix && plexItem) {
              // Still a placeholder - ensure label for filtered hub exclusion
              try {
                await plexClient.addLabelToItem(
                  plexItem.ratingKey,
                  'trailer-placeholder'
                );
                labelsFixed++;
              } catch (error) {
                logger.error('Failed to apply placeholder label', {
                  label: 'Collection Sync Service',
                  title: marker.title,
                  ratingKey: plexItem.ratingKey,
                  error:
                    error instanceof Error ? error.message : 'Unknown error',
                });
                // Skip title fix if label failed - no point fixing title
                // on an item that won't be filtered from hubs
                continue;
              }

              // Also fix episode title as secondary marker (overlay system)
              try {
                const fixed = await ensurePlaceholderEpisodeTitle(
                  plexClient,
                  plexItem.ratingKey,
                  marker.title
                );
                if (fixed) {
                  titlesFixes++;
                } else {
                  titleFixFailures++;
                  logger.warn(
                    'Failed to fix placeholder episode title (label still applied)',
                    {
                      label: 'Collection Sync Service',
                      title: marker.title,
                      ratingKey: plexItem.ratingKey,
                    }
                  );
                }
              } catch (error) {
                titleFixFailures++;
                logger.error(
                  'Failed to fix placeholder episode title (label still applied)',
                  {
                    label: 'Collection Sync Service',
                    title: marker.title,
                    ratingKey: plexItem.ratingKey,
                    error:
                      error instanceof Error ? error.message : 'Unknown error',
                  }
                );
              }
            }
            // Item on disk but not found in Plex — will be caught by post-sync hub verification
            if (needsTitleFix && !plexItem) {
              logger.warn(
                'Placeholder not matched in Plex during discovery (deferred to hub verification)',
                {
                  label: 'Collection Sync Service',
                  title: marker.title,
                  tmdbId: marker.tmdbId,
                }
              );
            }
          }

          logger.info('Global TV placeholder processing complete', {
            label: 'Collection Sync Service',
            libraryId: tvLibraryId,
            cleanedUp,
            labelsFixed,
            titlesFixes,
            titleFixFailures,
          });

          // Scoped Plex scan of the cleaned show folders to remove ghost entries (fire-and-forget)
          if (cleanedFolders.length > 0) {
            const libraryId = tvLibraryId;
            logger.info(
              'Triggering scoped Plex scan to clean up deleted TV placeholders',
              {
                label: 'Collection Sync Service',
                libraryId,
                placeholdersDeleted: cleanedUp,
                folders: cleanedFolders.length,
              }
            );
            // Fire-and-forget: don't block sync while Plex processes
            void (async () => {
              try {
                await removeGhostEntries(plexClient, libraryId, cleanedFolders);
                logger.info('Plex placeholder cleanup complete', {
                  label: 'Collection Sync Service',
                  libraryId,
                  folders: cleanedFolders.length,
                });
              } catch (cleanupError) {
                logger.warn('Failed to complete Plex placeholder cleanup', {
                  label: 'Collection Sync Service',
                  libraryId,
                  error:
                    cleanupError instanceof Error
                      ? cleanupError.message
                      : String(cleanupError),
                });
              }
            })();
          }
        } catch (error) {
          logger.warn('Failed to run global TV placeholder discovery', {
            label: 'Collection Sync Service',
            libraryId: tvLibraryId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // Collect all unique movie library IDs with placeholder-enabled collections
    const movieLibraryIds = [
      ...new Set(
        collectionConfigs
          .filter((c) => {
            if (!c.createPlaceholdersForMissing) return false;
            try {
              return getCollectionMediaType(c) === 'movie';
            } catch {
              return false;
            }
          })
          .map((c) => c.libraryId)
      ),
    ];

    if (movieLibraryIds.length > 0) {
      const { cleanupPlaceholderForRealContent, removeGhostEntries } =
        await import('@server/lib/placeholders/services/PlaceholderCleanup');

      for (const movieLibraryId of movieLibraryIds) {
        const movieLibraryPath = getPlaceholderRootFolder(
          movieLibraryId,
          'movie'
        );
        if (!movieLibraryPath) continue;

        try {
          logger.info('Running global movie placeholder discovery', {
            label: 'Collection Sync Service',
            libraryId: movieLibraryId,
            libraryPath: movieLibraryPath,
          });

          const discovered = await discoverMoviePlaceholdersFromFilenames(
            plexClient,
            movieLibraryId,
            movieLibraryPath
          );

          logger.info('Global movie placeholder discovery complete', {
            label: 'Collection Sync Service',
            libraryId: movieLibraryId,
            discovered: discovered.length,
          });

          movies.push(...discovered);

          // Process discovered movie placeholders: cleanup real content
          let moviesCleanedUp = 0;
          let labelsFixed = 0;
          const cleanedFolders: string[] = [];

          for (const { needsCleanup, movie, plexItem } of discovered) {
            // Cleanup triggers when needsCleanup is true (real content detected via Plex OR *arr)
            // This works even without a plexItem (content downloaded to different library)
            if (needsCleanup) {
              await cleanupPlaceholderForRealContent(
                movie.tmdbId,
                movie.placeholderPath,
                'movie',
                plexClient,
                plexItem?.ratingKey
              );
              moviesCleanedUp++;
              cleanedFolders.push(movie.folderPath);
            } else if (plexItem) {
              // Still a placeholder - ensure label for filtered hub exclusion
              try {
                await plexClient.addLabelToItem(
                  plexItem.ratingKey,
                  'trailer-placeholder'
                );
                labelsFixed++;
              } catch (error) {
                logger.error('Failed to apply placeholder label', {
                  label: 'Collection Sync Service',
                  title: movie.title,
                  ratingKey: plexItem.ratingKey,
                  error:
                    error instanceof Error ? error.message : 'Unknown error',
                });
              }
            }
          }

          logger.info('Global movie placeholder processing complete', {
            label: 'Collection Sync Service',
            libraryId: movieLibraryId,
            cleanedUp: moviesCleanedUp,
            labelsFixed,
          });

          // Scoped Plex scan of the cleaned movie folders to remove ghost entries (fire-and-forget)
          if (cleanedFolders.length > 0) {
            const libraryId = movieLibraryId;
            logger.info(
              'Triggering scoped Plex scan to clean up deleted movie placeholders',
              {
                label: 'Collection Sync Service',
                libraryId,
                placeholdersDeleted: moviesCleanedUp,
                folders: cleanedFolders.length,
              }
            );
            // Fire-and-forget: don't block sync while Plex processes
            void (async () => {
              try {
                await removeGhostEntries(plexClient, libraryId, cleanedFolders);
                logger.info('Plex placeholder cleanup complete', {
                  label: 'Collection Sync Service',
                  libraryId,
                  folders: cleanedFolders.length,
                });
              } catch (cleanupError) {
                logger.warn('Failed to complete Plex placeholder cleanup', {
                  label: 'Collection Sync Service',
                  libraryId,
                  error:
                    cleanupError instanceof Error
                      ? cleanupError.message
                      : String(cleanupError),
                });
              }
            })();
          }
        } catch (error) {
          logger.warn('Failed to run global movie placeholder discovery', {
            label: 'Collection Sync Service',
            libraryId: movieLibraryId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return { tv, movies };
  }

  /**
   * Sync all collection configurations using their respective sync services
   * This replaces the 84-line switch statement with clean, maintainable code
   */
  public async syncAllConfigurations(
    plexClient: PlexAPI,
    onProgress?: (
      processed: number,
      currentCollectionName?: string,
      total?: number
    ) => void
  ): Promise<SyncResult & { processedCollectionKeys: Set<string> }> {
    this.cancelled = false;
    const settings = getSettings();
    const collectionConfigs = settings.plex.collectionConfigs || [];

    logger.info(
      `Starting collections sync (${collectionConfigs.length} configs)`,
      {
        label: 'Collection Sync Service',
      }
    );

    // Check which specific Overseerr collection types are active
    const hasUsersConfig = collectionConfigs.some(
      (config) => config.type === 'overseerr' && config.subtype === 'users'
    );
    const hasServerOwnerConfig = collectionConfigs.some(
      (config) =>
        config.type === 'overseerr' && config.subtype === 'server_owner'
    );

    if (hasUsersConfig || hasServerOwnerConfig) {
      logger.info(
        `Detected Overseerr collections - applying pre-sync user restrictions (users: ${hasUsersConfig}, server_owner: ${hasServerOwnerConfig})`,
        {
          label: 'Collection Sync Service',
          hasUsersConfig,
          hasServerOwnerConfig,
        }
      );

      try {
        onProgress?.(0, 'Applying Seerr user restrictions...');
        await this.applyPreSyncUserRestrictions(
          hasUsersConfig,
          hasServerOwnerConfig
        );
        logger.info('Pre-sync user restrictions applied successfully', {
          label: 'Collection Sync Service',
        });
      } catch (error) {
        logger.error(
          'Failed to apply pre-sync user restrictions - continuing with sync',
          {
            label: 'Collection Sync Service',
            error: error instanceof Error ? error.message : String(error),
          }
        );
      }
    } else if (settings.main.overseerrLabelsApplied !== false) {
      // No Overseerr user configs exist but labels might be applied - clean them up
      // This handles: true (labels known to be applied) and undefined (unknown state, be safe for existing users)
      logger.info(
        'No Overseerr user collections detected but labels might exist - cleaning up user filter labels',
        {
          label: 'Collection Sync Service',
          labelState: settings.main.overseerrLabelsApplied,
        }
      );

      try {
        onProgress?.(0, 'Cleaning up user filter labels...');
        await this.cleanupUserFilterLabels();
        logger.info('User filter labels cleanup completed successfully', {
          label: 'Collection Sync Service',
        });
      } catch (error) {
        logger.warn(
          'Failed to cleanup user filter labels - continuing with sync',
          {
            label: 'Collection Sync Service',
            error: error instanceof Error ? error.message : String(error),
          }
        );
      }
    } else {
      // No Overseerr user configs and labels confirmed not applied - skip cleanup entirely
      logger.debug(
        'No Overseerr user collections detected and labels confirmed not applied - skipping cleanup',
        {
          label: 'Collection Sync Service',
        }
      );
    }

    // OPTIMIZATION: Use shared library cache for sync optimization
    // This eliminates repeated API calls across all collection sources
    onProgress?.(0, 'Loading shared library cache...');

    const { libraryCacheService } = await import('./LibraryCacheService');
    const libraryCache = await libraryCacheService.getCache(plexClient);
    const cachedLibraryCount = Object.keys(libraryCache).length;

    logger.info(
      `Shared library cache ready (${cachedLibraryCount} libraries cached)`,
      {
        label: 'Collection Sync Service',
        cachedLibraries: cachedLibraryCount,
      }
    );

    // Pre-fetch Overseerr requests cache
    onProgress?.(0, 'Pre-fetching Overseerr requests...');
    const overseerrRequestsCache = await this.prefetchOverseerrRequests();

    // Pre-fetch placeholder discovery cache
    onProgress?.(0, 'Discovering placeholders...');
    const placeholderDiscovery = await this.prefetchPlaceholderDiscovery(
      plexClient,
      collectionConfigs,
      libraryCache
    );

    // Initialize the global sync cache service for use across all sync operations
    syncCacheService.initialize(overseerrRequestsCache, libraryCache);
    syncCacheService.setPlaceholderDiscoveryCache(
      placeholderDiscovery.tv,
      placeholderDiscovery.movies
    );

    logger.info('Sync caches ready, starting collection processing', {
      label: 'Collection Sync Service',
      libraryCache: cachedLibraryCount,
      requestsCache: overseerrRequestsCache.length,
      placeholderDiscoveryTv: placeholderDiscovery.tv.length,
      placeholderDiscoveryMovies: placeholderDiscovery.movies.length,
    });

    let totalCreated = 0;
    let totalUpdated = 0;
    const processedCollectionKeys = new Set<string>();
    let processedCount = 0;

    // Cache getAllCollections() across loop iterations to avoid redundant Plex API calls.
    // Re-fetched only when a collection is created or deleted (structural changes to the list).
    // Item-level updates (adding/removing items) don't change collection metadata.
    let cachedAllCollections: Awaited<
      ReturnType<PlexAPI['getAllCollections']>
    > | null = null;

    // Process filtered hubs last so excluded collections have final titles in Plex.
    // collection!= uses exact string matching — title drift breaks exclusions.
    const regularConfigs = collectionConfigs.filter(
      (c) => c.type !== 'filtered_hub'
    );
    const filteredHubConfigs = collectionConfigs.filter(
      (c) => c.type === 'filtered_hub'
    );
    const orderedConfigs = [...regularConfigs, ...filteredHubConfigs];

    // Count unique logical collections (linked configs across libraries = one collection)
    const countedLinkIds = new Set<number>();
    let uniqueCollectionCount = 0;
    for (const c of orderedConfigs) {
      if (c.isLinked && c.linkId != null) {
        if (!countedLinkIds.has(c.linkId)) {
          countedLinkIds.add(c.linkId);
          uniqueCollectionCount++;
        }
      } else {
        uniqueCollectionCount++;
      }
    }

    collectionSyncProgress.setTotalCollections(uniqueCollectionCount);
    onProgress?.(0, 'Processing collections...', uniqueCollectionCount);
    let refreshedForFilteredHubs = false;
    const processedLinkIds = new Set<number>();

    for (const config of orderedConfigs) {
      if (this.cancelled) break;

      // Linked configs across libraries represent one logical collection
      const isNewUniqueCollection = !(
        config.isLinked &&
        config.linkId != null &&
        processedLinkIds.has(config.linkId)
      );
      if (config.isLinked && config.linkId != null) {
        processedLinkIds.add(config.linkId);
      }

      try {
        let created = 0;
        let updated = 0;

        // Report collection processing start
        onProgress?.(
          processedCount,
          `Processing "${config.name}"...`,
          uniqueCollectionCount
        );
        collectionSyncProgress.startCollection(
          config.id,
          config.name,
          config.type
        );

        // Wait for API access for this collection type to prevent concurrent access
        const { IndividualCollectionScheduler } = await import(
          './IndividualCollectionScheduler'
        );
        await IndividualCollectionScheduler.waitForApiAccess(
          config.type,
          config.id,
          config.name,
          config.libraryId
        );

        // Check if this collection has custom scheduling enabled
        const hasCustomSchedule = config.customSyncSchedule?.enabled;

        if (hasCustomSchedule) {
          // Skip content sync for custom scheduled collections - cleanup handles them via label matching
          onProgress?.(
            processedCount,
            `Skipping content sync for "${config.name}" (custom scheduled)...`,
            uniqueCollectionCount
          );
          collectionSyncProgress.completeCollection(
            'skipped',
            0,
            0,
            undefined,
            isNewUniqueCollection
          );

          logger.debug(
            `Skipped content sync for custom scheduled collection: ${config.name}`,
            {
              label: 'Collection Sync Service',
              configId: config.id,
            }
          );
        } else {
          // Force-refresh cache once before filtered hub phase so exclusion title
          // resolution reads post-sync titles. Title updates don't set mutated=true.
          if (
            config.type === 'filtered_hub' &&
            !refreshedForFilteredHubs &&
            cachedAllCollections !== null
          ) {
            cachedAllCollections = null;
            refreshedForFilteredHubs = true;
            logger.debug(
              'Invalidating getAllCollections cache before filtered hub phase',
              { label: 'Collection Sync Service' }
            );
          }

          // Use cached collections list, re-fetching only when stale
          if (!cachedAllCollections) {
            logger.debug('Fetching getAllCollections from Plex API', {
              label: 'Collection Sync Service',
              reason: processedCount === 0 ? 'initial' : 'cache-invalidated',
            });
            cachedAllCollections = await plexClient.getAllCollections();
          }
          const allCollections = cachedAllCollections;

          let result: SyncResult;
          if (config.type === 'multi-source') {
            // Use new multi-source orchestrator for distinct multi-source collections
            const { MultiSourceOrchestrator } = await import(
              './MultiSourceOrchestrator'
            );
            const orchestrator = new MultiSourceOrchestrator();

            // Convert CollectionConfig to MultiSourceCollectionConfig format
            const multiSourceConfig: MultiSourceCollectionConfig = {
              id: config.id,
              name: config.name,
              type: 'multi-source',
              visibilityConfig: config.visibilityConfig,
              mediaType: getCollectionMediaType(config),
              libraryId: config.libraryId,
              libraryName: config.libraryName,
              maxItems: config.maxItems ?? 50, // Provide default for multi-source
              template: config.template || '', // Provide default for multi-source
              sources:
                config.sources?.map((source) => ({
                  id: source.id,
                  type: source.type as MultiSourceType,
                  subtype: source.subtype || '',
                  customUrl: source.customUrl,
                  timePeriod: source.timePeriod as
                    | 'daily'
                    | 'weekly'
                    | 'monthly'
                    | 'all'
                    | undefined,
                  customDays: source.customDays,
                  minimumPlays: source.minimumPlays,
                  priority: source.priority,
                  networksCountry: source.networksCountry,
                  radarrTagServerId: source.radarrTagServerId,
                  radarrTagId: source.radarrTagId,
                  radarrTagLabel: source.radarrTagLabel,
                  sonarrTagServerId: source.sonarrTagServerId,
                  sonarrTagId: source.sonarrTagId,
                  sonarrTagLabel: source.sonarrTagLabel,
                })) || [],
              combineMode:
                (config.combineMode as MultiSourceCombineMode) || 'list_order',
              isActive: config.isActive,
              sortOrderHome: config.sortOrderHome,
              sortOrderLibrary: config.sortOrderLibrary,
              isLibraryPromoted: config.isLibraryPromoted,
              timeRestriction: config.timeRestriction,
              customPoster: config.customPoster,
              autoPoster: config.autoPoster,
              autoPosterTemplate: config.autoPosterTemplate,
              // Wallpaper, summary, and theme settings
              customWallpaper: config.customWallpaper,
              customSummary: config.customSummary,
              customTheme: config.customTheme,
              enableCustomWallpaper: config.enableCustomWallpaper,
              enableCustomSummary: config.enableCustomSummary,
              enableCustomTheme: config.enableCustomTheme,
              // Missing items / auto-download settings
              downloadMode: config.downloadMode,
              searchMissingMovies: config.searchMissingMovies,
              searchMissingTV: config.searchMissingTV,
              autoApproveMovies: config.autoApproveMovies,
              autoApproveTV: config.autoApproveTV,
              maxSeasonsToRequest: config.maxSeasonsToRequest,
              seasonsPerShowLimit: config.seasonsPerShowLimit,
              seasonGrabOrder: config.seasonGrabOrder,
              maxPositionToProcess: config.maxPositionToProcess,
              minimumYear: config.minimumYear,
              minimumImdbRating: config.minimumImdbRating,
              minimumRottenTomatoesRating: config.minimumRottenTomatoesRating,
              minimumRottenTomatoesAudienceRating:
                config.minimumRottenTomatoesAudienceRating,
              filterSettings: config.filterSettings,
              directDownloadRadarrServerId: config.directDownloadRadarrServerId,
              directDownloadRadarrProfileId:
                config.directDownloadRadarrProfileId,
              directDownloadRadarrRootFolder:
                config.directDownloadRadarrRootFolder,
              directDownloadSonarrServerId: config.directDownloadSonarrServerId,
              directDownloadSonarrProfileId:
                config.directDownloadSonarrProfileId,
              directDownloadSonarrRootFolder:
                config.directDownloadSonarrRootFolder,
              // Smart collection settings (unwatched filter feature)
              showUnwatchedOnly: config.showUnwatchedOnly,
              smartCollectionSort: config.smartCollectionSort,
              // Placeholder creation settings
              createPlaceholdersForMissing: config.createPlaceholdersForMissing,
              placeholderDaysAhead: config.placeholderDaysAhead,
              placeholderReleasedDays: config.placeholderReleasedDays,
              includeAllReleasedItems: config.includeAllReleasedItems,
              placeholderMinimumYear: config.placeholderMinimumYear,
              placeholderMinimumImdbRating: config.placeholderMinimumImdbRating,
              placeholderMinimumRottenTomatoesRating:
                config.placeholderMinimumRottenTomatoesRating,
              placeholderMinimumRottenTomatoesAudienceRating:
                config.placeholderMinimumRottenTomatoesAudienceRating,
              placeholderFilterSettings: config.placeholderFilterSettings,
              applyOverlaysDuringSync: config.applyOverlaysDuringSync,
            };

            result = await orchestrator.processMultiSourceCollection(
              multiSourceConfig,
              plexClient,
              allCollections,
              processedCollectionKeys,
              libraryCache,
              undefined // options
            );
          } else {
            // Use normal single-source sync
            const syncService = await this.createSyncService(config.type);
            result = await syncService.processCollections(
              [config],
              plexClient,
              allCollections,
              processedCollectionKeys,
              libraryCache
            );
          }

          created += result.created || 0;
          updated += result.updated || 0;

          // Invalidate cache if sync mutated Plex (created or deleted collections)
          if (result.mutated) {
            cachedAllCollections = null;
            logger.debug(
              `getAllCollections cache invalidated after ${config.name}`,
              { label: 'Collection Sync Service' }
            );
          }

          // Check if the sync returned an error or warning
          if (result.error) {
            logger.warn(
              `Collection sync returned error for ${config.name}: ${result.error}`,
              {
                label: 'Collection Sync Service',
                configId: config.id,
              }
            );
            // Persist error for UI display — keeps needsSync=true
            settings.setCollectionSyncError(config.id, result.error);
            collectionSyncProgress.completeCollection(
              'error',
              created,
              updated,
              result.error,
              isNewUniqueCollection
            );
          } else if (result.warning) {
            logger.info(
              `Collection sync completed with warning for ${config.name}: ${result.warning}`,
              {
                label: 'Collection Sync Service',
                configId: config.id,
              }
            );
            // Synced successfully but with issues — mark synced, persist warning
            settings.setCollectionSyncWarning(config.id, result.warning);
            collectionSyncProgress.completeCollection(
              'success',
              created,
              updated,
              undefined,
              isNewUniqueCollection
            );
          } else {
            // Mark collection as successfully synced (clears any previous error/warning)
            settings.markCollectionSynced(config.id, 'collection');
            collectionSyncProgress.completeCollection(
              'success',
              created,
              updated,
              undefined,
              isNewUniqueCollection
            );
          }
        }

        totalCreated += created;
        totalUpdated += updated;

        if (created > 0 || updated > 0) {
          logger.info(
            `Collection processed: ${config.name} (created: ${created}, updated: ${updated})`,
            {
              label: 'Collection Sync Service',
            }
          );
        }

        // Update progress count (only for new unique collections)
        if (isNewUniqueCollection) processedCount++;
        onProgress?.(processedCount, undefined, uniqueCollectionCount);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error(
          `Failed to process collection ${config.name}: ${errorMessage}`,
          {
            label: 'Collection Sync Service',
            configId: config.id,
            error: errorMessage,
          }
        );

        // Persist error for UI display
        settings.setCollectionSyncError(config.id, errorMessage);
        collectionSyncProgress.completeCollection(
          'error',
          0,
          0,
          errorMessage,
          isNewUniqueCollection
        );

        if (isNewUniqueCollection) processedCount++;
        onProgress?.(processedCount, undefined, uniqueCollectionCount);
      } finally {
        // Always release the API, regardless of success or failure
        const { IndividualCollectionScheduler } = await import(
          './IndividualCollectionScheduler'
        );
        IndividualCollectionScheduler.releaseApiAccess(config.type);
      }
    }

    // Post-sync: verify filtered hub labels to catch any placeholders that leaked through
    try {
      onProgress?.(processedCount, 'Verifying filtered hub labels...');
      await this.verifyFilteredHubLabels(plexClient, collectionConfigs);
    } catch (error) {
      logger.warn('Filtered hub label verification failed', {
        label: 'Collection Sync Service',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Clear the sync cache after completion to free memory
    syncCacheService.clear();

    logger.debug('Sync caches cleared after completion', {
      label: 'Collection Sync Service',
    });

    return {
      created: totalCreated,
      updated: totalUpdated,
      processedCollectionKeys,
    };
  }

  /**
   * Verify filtered hub smart collections don't contain placeholder items.
   *
   * The hub IS the verification mechanism — it shows items WITHOUT the
   * trailer-placeholder label. Any placeholder visible in the hub has a
   * missing label. We check the hub contents, identify placeholders via
   * DB lookup (fast) or metadata inspection (fallback), and apply the label.
   */
  private async verifyFilteredHubLabels(
    plexClient: PlexAPI,
    collectionConfigs: CollectionConfig[]
  ): Promise<void> {
    const { PlaceholderItem } = await import('@server/entity/PlaceholderItem');
    const { PlaceholderContextService } = await import(
      '@server/lib/placeholders/services/PlaceholderContextService'
    );
    const { getRepository } = await import('@server/datasource');
    const { In } = await import('typeorm');

    // Dedupe by collectionRatingKey to avoid processing the same hub twice
    const seenRatingKeys = new Set<string>();
    const filteredHubConfigs = collectionConfigs.filter((c) => {
      if (c.type !== 'filtered_hub' || !c.collectionRatingKey) return false;
      if (seenRatingKeys.has(c.collectionRatingKey)) return false;
      seenRatingKeys.add(c.collectionRatingKey);
      return true;
    });

    if (filteredHubConfigs.length === 0) return;

    const contextService = new PlaceholderContextService();
    let totalChecked = 0;
    let totalLeaks = 0;
    let totalFixed = 0;
    let totalFailed = 0;

    for (const config of filteredHubConfigs) {
      try {
        const hubRatingKey = config.collectionRatingKey as string;

        // Get items currently visible in the hub (items WITHOUT the label)
        const hubItemKeys = await plexClient.getCollectionItems(hubRatingKey);
        if (hubItemKeys.length === 0) continue;

        totalChecked += hubItemKeys.length;

        // Batch DB lookup: which hub items are known placeholders?
        // Chunk to stay within SQLite parameter limits (max 999)
        const repo = getRepository(PlaceholderItem);
        const dbMatches: InstanceType<typeof PlaceholderItem>[] = [];
        const DB_CHUNK_SIZE = 500;
        for (let i = 0; i < hubItemKeys.length; i += DB_CHUNK_SIZE) {
          const chunk = hubItemKeys.slice(i, i + DB_CHUNK_SIZE);
          const results = await repo.find({
            where: { plexRatingKey: In(chunk) },
            select: ['plexRatingKey', 'title'],
          });
          dbMatches.push(...results);
        }
        const dbMatchKeys = new Set(
          dbMatches.map((m) => m.plexRatingKey).filter(Boolean)
        );

        // Items in DB are confirmed placeholders — apply label
        for (const match of dbMatches) {
          if (!match.plexRatingKey) continue;
          totalLeaks++;
          try {
            await plexClient.addLabelToItem(
              match.plexRatingKey,
              'trailer-placeholder'
            );
            totalFixed++;
            logger.info(
              'Hub verification: applied missing label to placeholder',
              {
                label: 'Collection Sync Service',
                title: match.title,
                ratingKey: match.plexRatingKey,
                hub: config.name,
              }
            );
          } catch (error) {
            totalFailed++;
            logger.error('Hub verification: failed to apply label', {
              label: 'Collection Sync Service',
              title: match.title,
              ratingKey: match.plexRatingKey,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // For remaining hub items not in DB, check metadata as fallback
        const unknownKeys = hubItemKeys.filter((k) => !dbMatchKeys.has(k));
        if (unknownKeys.length > 0) {
          const metadataBatch = await plexClient.getMetadataBatch(unknownKeys);

          // Log if batch fetch missed items (partial chunk failure)
          const unverifiedCount = unknownKeys.filter(
            (k) => !metadataBatch.has(k)
          ).length;
          if (unverifiedCount > 0) {
            logger.warn(
              `Hub verification: ${unverifiedCount} items could not be fetched from Plex (will retry next sync)`,
              {
                label: 'Collection Sync Service',
                hub: config.name,
                unverified: unverifiedCount,
                total: unknownKeys.length,
              }
            );
          }

          for (const [ratingKey, metadata] of metadataBatch) {
            // Adapter for isPlaceholderItemAsync — it calls
            // query(`/library/metadata/${ratingKey}/children`).
            // We bypass getChildrenMetadata because it has the same
            // `Metadata || Directory` truthy-empty-array bug: if Plex
            // returns seasons in Directory with empty Metadata, they
            // get dropped. Instead use getMetadata(includeChildren)
            // and merge both arrays.
            const plexApiAdapter = {
              query: async () => {
                const resp = await plexClient.getMetadata(ratingKey, {
                  includeChildren: true,
                });
                const children = resp?.Children;
                const allChildren = [
                  ...(children?.Metadata || []),
                  ...(children?.Directory || []),
                ];
                return {
                  MediaContainer: {
                    Metadata: allChildren.length > 0 ? allChildren : undefined,
                  },
                };
              },
            };
            let isPlaceholder = false;
            try {
              isPlaceholder = await contextService.isPlaceholderItemAsync(
                metadata,
                plexApiAdapter
              );
            } catch (error) {
              logger.debug(
                'Hub verification: placeholder check failed for item',
                {
                  label: 'Collection Sync Service',
                  ratingKey,
                  title: metadata.title,
                  error: error instanceof Error ? error.message : String(error),
                }
              );
            }

            if (isPlaceholder) {
              totalLeaks++;
              try {
                await plexClient.addLabelToItem(
                  ratingKey,
                  'trailer-placeholder'
                );
                totalFixed++;
                logger.info(
                  'Hub verification: applied missing label to non-DB placeholder',
                  {
                    label: 'Collection Sync Service',
                    title: metadata.title,
                    ratingKey,
                    hub: config.name,
                  }
                );
              } catch (error) {
                totalFailed++;
                logger.error('Hub verification: failed to apply label', {
                  label: 'Collection Sync Service',
                  title: metadata.title,
                  ratingKey,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          }
        }
      } catch (error) {
        logger.warn(
          `Hub verification failed for "${config.name}", continuing with remaining hubs`,
          {
            label: 'Collection Sync Service',
            hub: config.name,
            error: error instanceof Error ? error.message : String(error),
          }
        );
      }
    }

    if (totalLeaks > 0) {
      logger.warn(
        `Hub verification found ${totalLeaks} placeholder leaks, ${totalFixed} fixed, ${totalFailed} failed`,
        {
          label: 'Collection Sync Service',
          checked: totalChecked,
          leaks: totalLeaks,
          fixed: totalFixed,
          failed: totalFailed,
        }
      );
    } else {
      logger.info('Hub verification clean — no placeholder leaks detected', {
        label: 'Collection Sync Service',
        checked: totalChecked,
      });
    }
  }

  /**
   * Apply user filter restrictions before sync to prevent visibility window
   * This ensures users can't see each other's collections during the sync process
   */
  private async applyPreSyncUserRestrictions(
    hasUsersConfig: boolean,
    hasServerOwnerConfig: boolean
  ): Promise<void> {
    try {
      // Import the user management functions
      const { applySelectivePreSyncUserRestrictions } = await import(
        '@server/lib/collections/plex/PlexUserManager'
      );

      // Apply restrictions only for the specific collection types that are active
      await applySelectivePreSyncUserRestrictions(
        hasUsersConfig,
        hasServerOwnerConfig
      );

      // Mark labels as applied
      const settings = getSettings();
      settings.setOverseerrLabelsApplied(true);
    } catch (error) {
      throw new Error(
        `Failed to apply pre-sync user restrictions: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Clean up user filter labels when no Overseerr user configs exist
   * Removes AgregarrOverseerr* labels from all users' filter settings
   */
  private async cleanupUserFilterLabels(): Promise<void> {
    try {
      // Import user management functions
      const { getAllPlexUserIds, updateUserFilterSettings } = await import(
        '@server/lib/collections/plex/PlexUserManager'
      );

      // Get all Plex users. Force a refresh so this cleanup pass reads the
      // user's current Plex sharing settings rather than a stale snapshot.
      const allPlexUserIds = await getAllPlexUserIds(true);
      if (allPlexUserIds.length === 0) {
        logger.debug('No Plex users found - skipping user filter cleanup', {
          label: 'Collection Sync Service',
        });
        return;
      }

      // Clean up each user's filter settings to remove Agregarr labels
      for (const userId of allPlexUserIds) {
        try {
          // Pass empty array for activeOverseerrUserIds to remove all Agregarr labels
          await updateUserFilterSettings(userId, allPlexUserIds, []);
        } catch (error) {
          logger.warn(
            `Failed to cleanup user filter labels for user ${userId}`,
            {
              label: 'Collection Sync Service',
              userId,
              error: error instanceof Error ? error.message : String(error),
            }
          );
        }
      }

      logger.info(
        `Cleaned up user filter labels for ${allPlexUserIds.length} users`,
        {
          label: 'Collection Sync Service',
          usersProcessed: allPlexUserIds.length,
        }
      );

      // Mark labels as removed
      const settings = getSettings();
      settings.setOverseerrLabelsApplied(false);
    } catch (error) {
      throw new Error(
        `Failed to cleanup user filter labels: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Create the appropriate sync service for a given collection type
   * Simple factory method without over-engineering
   */
  public async createSyncService(
    type: string
  ): Promise<BaseCollectionSync<CollectionSource>> {
    switch (type) {
      case 'trakt': {
        const { TraktCollectionSync } = await import('../sources/trakt');
        return new TraktCollectionSync();
      }
      case 'mdblist': {
        const { MDBListCollectionSync } = await import('../sources/mdblist');
        return new MDBListCollectionSync();
      }
      case 'tmdb': {
        const { TmdbCollectionSync } = await import('../sources/tmdb');
        return new TmdbCollectionSync();
      }
      case 'imdb': {
        const { ImdbCollectionSync } = await import('../sources/imdb');
        return new ImdbCollectionSync();
      }
      case 'tautulli': {
        const { TautulliCollectionSync } = await import('../sources/tautulli');
        return new TautulliCollectionSync();
      }
      case 'letterboxd': {
        const { LetterboxdCollectionSync } = await import(
          '../sources/letterboxd'
        );
        return new LetterboxdCollectionSync();
      }
      case 'networks': {
        const { NetworksCollectionSync } = await import('../sources/networks');
        return new NetworksCollectionSync();
      }
      case 'originals': {
        const { OriginalsCollectionSync } = await import(
          '../sources/originals'
        );
        return new OriginalsCollectionSync();
      }
      case 'anilist': {
        const { AnilistCollectionSync } = await import('../sources/anilist');
        return new AnilistCollectionSync();
      }
      case 'myanimelist': {
        const { MyAnimeListCollectionSync } = await import(
          '../sources/myanimelist'
        );
        return new MyAnimeListCollectionSync();
      }
      case 'overseerr': {
        const { OverseerrCollectionSync } = await import(
          '../sources/overseerrSync'
        );
        return new OverseerrCollectionSync();
      }
      case 'radarrtag': {
        const { RadarrTagCollectionSync } = await import('../sources/radarr');
        return new RadarrTagCollectionSync();
      }
      case 'sonarrtag': {
        const { SonarrTagCollectionSync } = await import('../sources/sonarr');
        return new SonarrTagCollectionSync();
      }
      case 'comingsoon': {
        const { ComingSoonCollectionSync } = await import(
          '../sources/comingsoon'
        );
        return new ComingSoonCollectionSync();
      }
      case 'filtered_hub': {
        const { FilteredHubCollectionSync } = await import(
          '../sources/recentlyadded'
        );
        return new FilteredHubCollectionSync();
      }
      case 'plex': {
        const { PlexLibraryCollectionSync } = await import(
          '../sources/plexlibrary'
        );
        return new PlexLibraryCollectionSync();
      }
      case 'multi-source':
        throw new Error(
          'Multi-source collections should be handled by MultiSourceOrchestrator, not individual sync services'
        );
      default:
        throw new Error(`Unknown collection type: ${type}`);
    }
  }
}

// Create and export singleton instance
export const collectionSyncService = new CollectionSyncService();
export default collectionSyncService;

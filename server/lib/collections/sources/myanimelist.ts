import { ensureAnimeIdsLoaded, lookupByMal } from '@server/api/animeIds';
import {
  getRankedAnime,
  type MALAnime,
  type MALRankingType,
} from '@server/api/myanimelist';
import type PlexAPI from '@server/api/plexapi';
import { BaseCollectionSync } from '@server/lib/collections/core/BaseCollectionSync';
import type { LibraryItemsCache } from '@server/lib/collections/core/CollectionUtilities';
import {
  deduplicateMissingItems,
  getCollectionMediaType,
  processMissingItemsWithMode,
} from '@server/lib/collections/core/CollectionUtilities';
import type {
  CollectionItem,
  CollectionOperationResult,
  CollectionSourceData,
  MissingItem,
  PlexCollection,
  SyncResult,
} from '@server/lib/collections/core/types';
import {
  buildLibraryProviderIndex,
  findMappedAnime,
  resolveAnimeTmdbId,
  type ProviderIndex,
} from '@server/lib/collections/utils/AnimeProviderIndex';
import type { CollectionConfig } from '@server/lib/settings';
import logger from '@server/logger';

export class MyAnimeListCollectionSync extends BaseCollectionSync<'myanimelist'> {
  constructor() {
    super('myanimelist');
  }

  protected async createCollection(
    items: CollectionItem[],
    mediaType: 'movie' | 'tv',
    collectionName: string,
    plexClient: PlexAPI,
    allCollections: PlexCollection[],
    config: CollectionConfig,
    processedCollectionKeys?: Set<string>
  ): Promise<CollectionOperationResult> {
    return await this.createOrUpdateCollectionStandardized(
      items,
      collectionName,
      mediaType,
      config,
      plexClient,
      allCollections,
      processedCollectionKeys
    );
  }

  protected async validateConfiguration(): Promise<void> {
    // MAL API key is required - check in settings
    const settings = await import('@server/lib/settings').then((m) =>
      m.getSettings()
    );
    if (!settings.myanimelist?.apiKey) {
      throw new Error('MyAnimeList API key is not configured');
    }
  }

  protected async processConfiguration(
    config: CollectionConfig,
    plexClient: PlexAPI,
    allCollections: PlexCollection[],
    processedCollectionKeys?: Set<string>,
    libraryCache?: LibraryItemsCache
  ): Promise<SyncResult> {
    try {
      // Fetch source data from MAL (with libraryCache for early matching)
      const sourceData = await this.fetchSourceData(
        config,
        undefined,
        libraryCache
      );

      // Map source data to collection items
      const mapped = await this.mapSourceDataToItems(
        sourceData,
        config,
        plexClient,
        libraryCache
      );

      // Apply filtering safety net
      const { items, missingItems } = await this.applyFilteringToMappedItems(
        mapped,
        config
      );

      // Tag existing items in Radarr/Sonarr (if enabled)
      await this.tagExistingItemsInArr(items, config);

      // Handle placeholder cleanup and process missing items
      const placeholderItems = await this.handlePlaceholdersAndMissingItems(
        items,
        missingItems,
        config,
        plexClient,
        libraryCache,
        missingItems && missingItems.length > 0
          ? async () => {
              try {
                await processMissingItemsWithMode(
                  missingItems,
                  config,
                  'myanimelist'
                );
              } catch (e) {
                logger.debug('Failed to process missing items for MAL', {
                  label: 'MyAnimeList Collections',
                  error: String(e),
                });
              }
            }
          : undefined
      );

      // Add placeholder items to the collection
      let finalItems = items;
      if (placeholderItems.length > 0) {
        finalItems = this.mergePlaceholders(
          items,
          placeholderItems,
          missingItems,
          config
        );
      }

      // If no items were mapped, return early
      if (finalItems.length === 0) {
        return { created: 0, updated: 0 };
      }

      // Process collection using media type strategy
      const result = await this.processWithMediaTypeStrategy(
        finalItems,
        config,
        plexClient,
        allCollections,
        processedCollectionKeys
      );

      return result;
    } catch (error) {
      logger.error('MyAnimeList collection processing failed', {
        label: 'MyAnimeList Collections',
        configName: config.name,
        configId: config.id,
        error:
          error instanceof Error
            ? {
                message: error.message,
                stack: error.stack,
                name: error.name,
              }
            : error,
      });
      throw error;
    }
  }

  protected async createTemplateContext(
    config: CollectionConfig,
    mediaType: 'movie' | 'tv'
  ) {
    const rankingType = (config.subtype as MALRankingType) || 'all';
    const context = this.templateEngine.createMyAnimeListContext(
      mediaType,
      rankingType
    );

    const configName = config.name || `MAL-${config.id}`;

    return {
      ...context,
      configName,
    };
  }

  // ---- Fetch ----
  public async fetchSourceData(
    config: CollectionConfig,
    options?: { apiTimeout?: number },
    libraryCache?: LibraryItemsCache
  ): Promise<CollectionSourceData[]> {
    await ensureAnimeIdsLoaded();
    const rankingType = (config.subtype as MALRankingType) || 'all';
    const perPage = 500; // MAL API maximum per request
    const maxItems = config.maxItems || 9999;
    const mediaType = getCollectionMediaType(config);

    const libraryIndex = libraryCache
      ? buildLibraryProviderIndex(libraryCache, config.libraryId, mediaType)
      : undefined;

    // Paginate through results with rate limiting and early matching checks
    const allData: CollectionSourceData[] = [];
    let offset = 0;
    const maxRequests = 20; // Safety limit (20 requests × 500 = 10,000 items)

    for (let i = 0; i < maxRequests && allData.length < 9999; i++) {
      const response = await getRankedAnime(rankingType, perPage, offset);

      if (!response.data || response.data.length === 0) break;

      // Filter results to match target media type
      const filteredData = response.data.filter((item) => {
        const itemMediaType = item.node.media_type;
        if (mediaType === 'movie') {
          return itemMediaType === 'movie';
        } else {
          // For TV libraries, include tv, ova, ona, special (exclude movie and music)
          return (
            itemMediaType === 'tv' ||
            itemMediaType === 'ova' ||
            itemMediaType === 'ona' ||
            itemMediaType === 'special'
          );
        }
      });

      const pageData = filteredData.map((item) => ({
        title: item.node.title,
        malId: item.node.id,
        rank: item.ranking.rank,
        raw: item.node,
      }));

      allData.push(...pageData);
      offset += perPage;

      // Check every 2 requests (1000 items) if we have enough matched items
      if (libraryIndex && (i + 1) % 2 === 0) {
        const matchedCount = this.countMatchedItems(
          allData,
          libraryIndex,
          mediaType
        );

        logger.debug(
          `MAL early matching check: ${matchedCount} matched items from ${allData.length} fetched (target: ${maxItems})`,
          {
            label: 'MyAnimeList Collections',
            configName: config.name,
            matchedCount,
            fetchedCount: allData.length,
            maxItems,
            currentRequest: i + 1,
          }
        );

        // If we have enough matched items to satisfy maxItems, stop fetching
        if (matchedCount >= maxItems) {
          logger.info(
            `MAL early termination: Found ${matchedCount} matched items (target: ${maxItems}) after ${
              i + 1
            } requests`,
            {
              label: 'MyAnimeList Collections',
              configName: config.name,
              matchedCount,
              maxItems,
              requestsFetched: i + 1,
            }
          );
          break;
        }
      }

      // If we got less than perPage, we've hit the end
      if (response.data.length < perPage) break;
    }

    return allData;
  }

  // ---- Map ----
  public async mapSourceDataToItems(
    sourceData: CollectionSourceData[],
    config: CollectionConfig,
    plexClient?: PlexAPI,
    libraryCache?: LibraryItemsCache
  ): Promise<{ items: CollectionItem[]; missingItems?: MissingItem[] }> {
    await ensureAnimeIdsLoaded();
    const items: CollectionItem[] = [];
    const missing: MissingItem[] = [];

    const mediaType = getCollectionMediaType(config);
    const libraryIndex = buildLibraryProviderIndex(
      libraryCache,
      config.libraryId,
      mediaType
    );

    for (let i = 0; i < sourceData.length; i++) {
      const entry = sourceData[i];
      if (!('raw' in entry) || !('malId' in entry)) continue;

      const raw = entry.raw as MALAnime;
      const malId = entry.malId;
      const displayTitle = raw.title || entry.title || 'Unknown';

      const ids = lookupByMal(malId, mediaType);
      if (!ids) continue;
      const tvdbId =
        mediaType === 'tv' && ids.tvdb ? Number(ids.tvdb) : undefined;
      const hit = findMappedAnime(libraryIndex, ids);
      if (hit) {
        items.push({
          ratingKey: hit.ratingKey,
          title: hit.title,
          type: mediaType,
          tmdbId: ids.tmdb ? Number(ids.tmdb) : undefined,
          tvdbId: mediaType === 'tv' ? hit.tvdbId ?? tvdbId : undefined,
          posterUrl:
            raw?.main_picture?.large || raw?.main_picture?.medium || undefined,
          metadata: { libraryKey: hit.libraryKey, originalPosition: i + 1 },
        });
        continue;
      }

      const itemMediaType = raw?.media_type === 'movie' ? 'movie' : 'tv';
      if (itemMediaType !== mediaType) continue;
      const tmdbId = await resolveAnimeTmdbId(ids, mediaType);
      if (tmdbId) {
        missing.push({
          tmdbId,
          tvdbId,
          mediaType: itemMediaType,
          title: displayTitle,
          originalPosition: i + 1,
          source: this.source,
        });
      }
    }

    return { items, missingItems: deduplicateMissingItems(missing) };
  }

  /**
   * Count how many items from the provided source data would match items in the library.
   * This is a lightweight version of the full mapping logic used for early termination checks.
   */
  private countMatchedItems(
    sourceData: CollectionSourceData[],
    libraryIndex: ProviderIndex,
    mediaType: 'movie' | 'tv'
  ): number {
    const seen = new Set<string>();
    for (const entry of sourceData) {
      if (!('malId' in entry)) continue;
      const hit = findMappedAnime(
        libraryIndex,
        lookupByMal(entry.malId, mediaType)
      );
      if (hit) seen.add(hit.ratingKey);
    }
    return seen.size;
  }
}

export default MyAnimeListCollectionSync;

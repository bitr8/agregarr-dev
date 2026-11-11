import type PlexAPI from '@server/api/plexapi';
import TvdbAPI, { parseTvdbListInput } from '@server/api/tvdb';
import { BaseCollectionSync } from '@server/lib/collections/core/BaseCollectionSync';
import {
  extractErrorCause,
  findPlexItemsByTmdbIds,
  getCollectionMediaType,
  processMissingItemsWithMode,
  type LibraryItemsCache,
} from '@server/lib/collections/core/CollectionUtilities';
import type {
  CollectionItem,
  CollectionOperationResult,
  CollectionSyncOptions,
  FilteringStats,
  MissingItem,
  PlexCollection,
  PlexLookupResult,
  SourceTemplateContext,
  SyncResult,
  TvdbSourceData,
} from '@server/lib/collections/core/types';
import { CollectionSyncErrorType } from '@server/lib/collections/core/types';
import type { CollectionConfig } from '@server/lib/settings';
import logger from '@server/logger';

const LOOKUP_BATCH_SIZE = 4;
const RETRY_DELAY_MS = 1000;

const httpStatus = (error: unknown): number | undefined =>
  (error as { response?: { status?: number } })?.response?.status;

const isRetryable = (error: unknown): boolean => {
  const status = httpStatus(error);
  return status === 429 || (status !== undefined && status >= 500);
};

interface TvdbCollectionItem extends CollectionItem {
  tmdbId: number;
}

export class TvdbCollectionSync extends BaseCollectionSync<'tvdb'> {
  private client?: TvdbAPI;

  constructor() {
    super('tvdb');
  }

  protected async validateConfiguration(): Promise<void> {
    // TVDB lists use the built-in project key; nothing to configure
  }

  protected async processConfiguration(
    config: CollectionConfig,
    plexClient: PlexAPI,
    allCollections: PlexCollection[],
    processedCollectionKeys?: Set<string>,
    libraryCache?: LibraryItemsCache,
    options?: CollectionSyncOptions
  ): Promise<SyncResult> {
    try {
      if (config.type !== 'tvdb' || !config.tvdbCustomListUrl) {
        throw this.createSyncError(
          CollectionSyncErrorType.CONFIGURATION_ERROR,
          `Invalid TVDB configuration: ${config.name}`
        );
      }

      const sourceData = await this.fetchSourceData(config, options);
      const mappedResult = await this.mapSourceDataToItems(
        sourceData,
        config,
        plexClient,
        libraryCache
      );
      const { items, missingItems } = await this.applyFilteringToMappedItems(
        mappedResult,
        config
      );

      await this.tagExistingItemsInArr(items, config);

      const placeholderItems = await this.handlePlaceholdersAndMissingItems(
        items,
        missingItems,
        config,
        plexClient,
        libraryCache,
        missingItems && missingItems.length > 0
          ? () => this.handleAutoRequests(missingItems, config)
          : undefined
      );

      const finalItems =
        placeholderItems.length > 0 ? [...items, ...placeholderItems] : items;

      if (finalItems.length === 0) {
        logger.warn('No items to create collection from', {
          label: 'TVDB Collections',
          configName: config.name,
        });
        return { created: 0, updated: 0 };
      }

      return await this.processWithMediaTypeStrategy(
        finalItems,
        config,
        plexClient,
        allCollections,
        processedCollectionKeys,
        undefined,
        libraryCache,
        missingItems
      );
    } catch (error) {
      logger.error(`TVDB collection error for "${config.name}"`, {
        label: 'TVDB Collections',
        configId: config.id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      throw this.createSyncError(
        CollectionSyncErrorType.COLLECTION_ERROR,
        `Failed to process TVDB collection ${config.name}`,
        { configId: config.id, configName: config.name },
        extractErrorCause(error)
      );
    }
  }

  protected async createTemplateContext(
    config: CollectionConfig,
    mediaType: 'movie' | 'tv'
  ): Promise<SourceTemplateContext> {
    return this.templateEngine.createTvdbContext(mediaType);
  }

  private async lookupWithRetry(
    client: TvdbAPI,
    kind: 'movie' | 'series',
    tvdbId: number
  ) {
    try {
      return await client.getEntityInfo(kind, tvdbId);
    } catch (error) {
      if (!isRetryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return await client.getEntityInfo(kind, tvdbId);
    }
  }

  public async fetchSourceData(
    config: CollectionConfig,
    options?: CollectionSyncOptions // eslint-disable-line @typescript-eslint/no-unused-vars
  ): Promise<TvdbSourceData[]> {
    const ref = parseTvdbListInput(config.tvdbCustomListUrl ?? '');
    if (!ref) {
      throw this.createSyncError(
        CollectionSyncErrorType.CONFIGURATION_ERROR,
        'A valid TVDB list URL is required'
      );
    }

    const mediaType = getCollectionMediaType(config);
    const kind = mediaType === 'movie' ? 'movie' : 'series';
    const client = (this.client ??= new TvdbAPI());

    try {
      const list = await client.getList(ref);
      const entries = (list.entities ?? [])
        .map((entity) => ({
          order: entity.order,
          tvdbId: kind === 'movie' ? entity.movieId : entity.seriesId,
        }))
        .filter((e): e is { order: number; tvdbId: number } => !!e.tvdbId)
        .sort((a, b) => a.order - b.order);

      const results: TvdbSourceData[] = [];
      const failedIds: number[] = [];
      const notFoundIds: number[] = [];
      for (let i = 0; i < entries.length; i += LOOKUP_BATCH_SIZE) {
        const batch = entries.slice(i, i + LOOKUP_BATCH_SIZE);
        const infos = await Promise.all(
          batch.map(async (entry) => {
            try {
              return await this.lookupWithRetry(client, kind, entry.tvdbId);
            } catch (error) {
              if (httpStatus(error) === 404) {
                notFoundIds.push(entry.tvdbId);
              } else {
                failedIds.push(entry.tvdbId);
              }
              return undefined;
            }
          })
        );
        batch.forEach((entry, idx) => {
          const info = infos[idx];
          if (!info) return;
          results.push({
            tvdbId: entry.tvdbId,
            tmdbId: info.tmdbId,
            title: info.name,
            year: info.year,
            mediaType,
            position: i + idx + 1,
          });
        });
      }

      if (notFoundIds.length > 0) {
        logger.info(
          `Skipping ${notFoundIds.length} ${kind} entries no longer on TVDB`,
          { label: 'TVDB Collections', tvdbIds: notFoundIds }
        );
      }

      if (entries.length > 0 && notFoundIds.length === entries.length) {
        throw new Error(
          `TVDB returned not found for all ${entries.length} entries`
        );
      }

      if (failedIds.length > 0) {
        logger.error(
          `TVDB lookup failed for ${failedIds.length} of ${entries.length} ${kind} entries; aborting so the existing collection is kept`,
          { label: 'TVDB Collections', failedIds }
        );
        throw new Error(
          `TVDB lookup failed for ${failedIds.length} of ${entries.length} entries`
        );
      }

      const unmapped = results.filter((r) => !r.tmdbId);
      if (unmapped.length > 0) {
        logger.info(
          `Skipping ${unmapped.length} ${kind} entries with no TMDB mapping in TVDB`,
          {
            label: 'TVDB Collections',
            tvdbIds: unmapped.map((r) => r.tvdbId),
          }
        );
      }

      return results;
    } catch (error) {
      logger.error(
        `TVDB API error: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { label: 'TVDB Collections', url: config.tvdbCustomListUrl }
      );
      throw this.createSyncError(
        CollectionSyncErrorType.API_ERROR,
        'Failed to fetch data from TVDB API',
        { mediaType },
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  public async mapSourceDataToItems(
    sourceData: TvdbSourceData[],
    config: CollectionConfig,
    plexClient?: PlexAPI,
    libraryCache?: LibraryItemsCache
  ): Promise<{
    items: TvdbCollectionItem[];
    missingItems?: MissingItem[];
    stats?: FilteringStats;
  }> {
    const items: TvdbCollectionItem[] = [];
    const missingItems: MissingItem[] = [];

    const lookups = sourceData
      .filter((d) => !!d.tmdbId)
      .map((d) => ({
        tmdbId: d.tmdbId as number,
        tvdbId: d.tvdbId,
        mediaType: d.mediaType,
        title: d.title,
        year: d.year,
        originalPosition: d.position,
      }));

    if (lookups.length === 0) {
      return {
        items,
        missingItems,
        stats: this.createFilteringStats(sourceData.length, 0, {
          'invalid data': sourceData.length,
        }),
      };
    }

    let plexLookup = new Map<string, PlexLookupResult>();
    if (plexClient) {
      const targetLibraryId = Array.isArray(config.libraryId)
        ? config.libraryId[0]
        : config.libraryId;
      plexLookup = await findPlexItemsByTmdbIds(
        plexClient,
        lookups,
        targetLibraryId,
        libraryCache,
        false
      );
    }

    for (const lookup of lookups) {
      const plexItem = plexLookup.get(`${lookup.tmdbId}-${lookup.mediaType}`);
      if (plexItem) {
        items.push({
          ratingKey: plexItem.ratingKey,
          title: plexItem.title,
          type: lookup.mediaType,
          tmdbId: lookup.tmdbId,
          tvdbId: plexItem.tvdbId,
          addedAt: plexItem.addedAt,
          releaseDate: plexItem.releaseDate,
          metadata: {
            libraryKey: plexItem.libraryKey,
            originalPosition: lookup.originalPosition,
          },
        });
      } else {
        missingItems.push({
          tmdbId: lookup.tmdbId,
          tvdbId: lookup.mediaType === 'tv' ? lookup.tvdbId : undefined,
          mediaType: lookup.mediaType,
          title: lookup.title,
          year: lookup.year,
          originalPosition: lookup.originalPosition,
          source: this.source,
        });
      }
    }

    return {
      items,
      missingItems,
      stats: this.createFilteringStats(sourceData.length, items.length, {
        'missing from plex': missingItems.length,
        'invalid data': sourceData.length - lookups.length,
      }),
    };
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
    try {
      const result = await this.createOrUpdateCollectionStandardized(
        items,
        collectionName,
        mediaType,
        config,
        plexClient,
        allCollections,
        processedCollectionKeys
      );
      this.updateConfigWithRatingKey(config, result.collectionRatingKey);
      return {
        created: result.created,
        updated: result.updated,
        collectionRatingKey: result.collectionRatingKey,
        itemCount: result.itemCount || items.length,
        stats: result.stats,
      };
    } catch (error) {
      throw this.createSyncError(
        CollectionSyncErrorType.COLLECTION_ERROR,
        `Failed to create TVDB collection ${collectionName}`,
        { collectionName, itemCount: items.length },
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  private async handleAutoRequests(
    missingItems: MissingItem[],
    config: CollectionConfig
  ): Promise<void> {
    await processMissingItemsWithMode(missingItems, config, 'tvdb');
  }
}

export default TvdbCollectionSync;

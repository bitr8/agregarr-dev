import {
  getFeedsFirstPage,
  getPopularAnime,
  getTopRatedAnime,
  getTrendingAnime,
  getUserCustomLists,
  searchAnime,
  type AniListCustomList,
  type AniListMedia,
} from '@server/api/anilist';
import { ensureAnimeIdsLoaded, lookupByAniList } from '@server/api/animeIds';
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
  CollectionSyncOptions,
  MissingItem,
  PlexCollection,
  SyncResult,
} from '@server/lib/collections/core/types';
import {
  buildLibraryProviderIndex,
  findMappedAnime,
  resolveAnimeTmdbId,
  type ProviderIndex,
  type ProviderIndexEntry,
} from '@server/lib/collections/utils/AnimeProviderIndex';
import type { CollectionConfig } from '@server/lib/settings';
import logger from '@server/logger';

export class AnilistCollectionSync extends BaseCollectionSync<'anilist'> {
  constructor() {
    super('anilist');
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
    // Use the standardized collection creation pipeline
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
    // AniList is public; nothing to validate here
    return;
  }

  protected async processConfiguration(
    config: CollectionConfig,
    plexClient: PlexAPI,
    allCollections: PlexCollection[],
    processedCollectionKeys?: Set<string>,
    libraryCache?: LibraryItemsCache
  ): Promise<SyncResult> {
    try {
      // Ensure anime IDs are loaded for mapping
      await ensureAnimeIdsLoaded();

      // Fetch source data from AniList (with libraryCache for early matching)
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

      // Apply filtering safety net (validation, deduplication, maxItems safety check)
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
                  'anilist'
                );
              } catch (e) {
                logger.debug('Failed to process missing items for AniList', {
                  label: 'AniList Collections',
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

      // If no items were mapped, log a warning and return early
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
      logger.error('AniList collection processing failed', {
        label: 'AniList Collections',
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
    const subtype = (config.subtype as string) || 'trending';
    const context = this.templateEngine.createAnilistContext(
      mediaType,
      subtype
    );

    // Add unique identifier based on config name to ensure each collection gets its own name
    // This prevents multiple AniList collections with the same subtype from conflicting
    const configName = config.name || `AniList-${config.id}`;

    return {
      ...context,
      configName,
    };
  }

  // ---- Helpers for ID matching ----

  /**
   * Count how many items from the provided media array would match items in the library.
   * This is a lightweight version of the full mapping logic used for early termination checks.
   * Deduplicates by ratingKey to match the final preview behavior.
   */
  private countMatchedItems(
    media: AniListMedia[],
    libraryIndex: ProviderIndex,
    mediaType: 'movie' | 'tv'
  ): number {
    const seenRatingKeys = new Set<string>();

    for (const entry of media) {
      const ids = lookupByAniList(entry.id, mediaType, entry.idMal);
      const ratingKey =
        libraryIndex.anilist.get(String(entry.id))?.ratingKey ||
        findMappedAnime(libraryIndex, ids)?.ratingKey ||
        this.matchExternalLinks(libraryIndex, entry.externalLinks, mediaType)
          .hit?.ratingKey;
      if (ratingKey) seenRatingKeys.add(ratingKey);
    }

    return seenRatingKeys.size;
  }

  private matchExternalLinks(
    index: ProviderIndex,
    links: AniListMedia['externalLinks'],
    mediaType: 'movie' | 'tv'
  ) {
    const tmdbIds = new Set<string>();
    const matches = new Map<string, ProviderIndexEntry>();
    for (const link of links ?? []) {
      const url = link.url ?? '';
      const site = (link.site ?? '').toUpperCase();
      if (site.includes('TMDB') || /themoviedb\.org/i.test(url)) {
        const target = url.match(/\/(tv|movie)\/(\d+)/i);
        if (target?.[1].toLowerCase() === mediaType) {
          const id = target[2];
          tmdbIds.add(id);
          const hit = index.tmdb.get(id);
          if (hit) matches.set(hit.ratingKey, hit);
        }
      }
      if (site === 'IMDB' || /imdb\.com/i.test(url)) {
        const id = url.match(/(tt\d{6,})/i)?.[1].toLowerCase();
        const hit = id && index.imdb.get(id);
        if (hit) matches.set(hit.ratingKey, hit);
      }
    }
    return {
      hit:
        matches.size === 1
          ? (matches.values().next().value as ProviderIndexEntry)
          : undefined,
      tmdbId:
        tmdbIds.size === 1 && matches.size <= 1
          ? Number(tmdbIds.values().next().value)
          : undefined,
    };
  }

  // ---- Fetch ----
  public async fetchSourceData(
    config: CollectionConfig,
    options?: CollectionSyncOptions,
    libraryCache?: LibraryItemsCache
  ): Promise<CollectionSourceData[]> {
    // Ensure anime IDs are loaded for mapping (needed for preview which bypasses processConfiguration)
    await ensureAnimeIdsLoaded();

    const rawSubtype = (config.subtype || 'trending').toString();
    const subtype = rawSubtype.toLowerCase();
    const perPage = 50; // AniList API maximum per page

    // Get media type from config (this already returns 'movie' | 'tv')
    const mediaType = getCollectionMediaType(config);

    const tvFormats = ['TV', 'TV_SHORT', 'ONA', 'OVA', 'SPECIAL'] as const;

    const bestTitleFromMedia = (m: AniListMedia): string =>
      (
        m?.title?.english ||
        m?.title?.romaji ||
        m?.title?.native ||
        ''
      ).toString();

    const adapt = (arr: AniListMedia[]): CollectionSourceData[] =>
      arr.map((m) => ({
        title: bestTitleFromMedia(m),
        anilistId: m?.id,
        raw: m,
      }));

    // Build format filters based on target media type
    const formatFilters =
      mediaType === 'movie'
        ? { format: 'MOVIE' }
        : { formatIn: ['TV', 'TV_SHORT', 'ONA', 'OVA', 'SPECIAL'] };

    const libraryIndex = libraryCache
      ? buildLibraryProviderIndex(libraryCache, config.libraryId, mediaType)
      : undefined;

    // Paginate through results with rate limiting and early matching checks
    const paginateResults = async (
      fetchPage: (
        page: number,
        perPage: number
      ) => Promise<{
        Page: {
          media: AniListMedia[];
          pageInfo: { hasNextPage?: boolean | null };
        };
      }>
    ): Promise<AniListMedia[]> => {
      const allMedia: AniListMedia[] = [];
      let currentPage = 1;
      let hasNextPage = true;
      const maxPages = 200; // Safety limit (200 pages × 50 = 10,000 items)
      const maxItems = config.maxItems || 9999;

      while (hasNextPage && currentPage <= maxPages && allMedia.length < 9999) {
        const { Page } = await fetchPage(currentPage, perPage);
        if (!Page?.media || Page.media.length === 0) break;

        allMedia.push(...Page.media);
        hasNextPage = Page.pageInfo?.hasNextPage ?? false;
        currentPage++;

        // Check every 2 pages if we have enough matched items
        if (libraryIndex && currentPage % 2 === 0) {
          const matchedCount = this.countMatchedItems(
            allMedia,
            libraryIndex,
            mediaType
          );

          logger.debug(
            `AniList early matching check: ${matchedCount} matched items from ${allMedia.length} fetched (target: ${maxItems})`,
            {
              label: 'AniList Collections',
              configName: config.name,
              matchedCount,
              fetchedCount: allMedia.length,
              maxItems,
              currentPage: currentPage - 1,
            }
          );

          // If we have enough matched items to satisfy maxItems, stop fetching
          if (matchedCount >= maxItems) {
            logger.info(
              `AniList early termination: Found ${matchedCount} matched items (target: ${maxItems}) after ${
                currentPage - 1
              } pages`,
              {
                label: 'AniList Collections',
                configName: config.name,
                matchedCount,
                maxItems,
                pagesFetched: currentPage - 1,
              }
            );
            break;
          }
        }
      }

      return allMedia;
    };

    if (subtype === 'popular') {
      const allMedia = await paginateResults((page, perPage) =>
        getPopularAnime(page, perPage, false, formatFilters)
      );
      if (allMedia.length === 0) {
        const feeds = await getFeedsFirstPage(perPage, false);
        return adapt(feeds.popular ?? []);
      }
      return adapt(allMedia);
    }

    if (
      subtype === 'top' ||
      subtype === 'top_rated' ||
      subtype === 'toprated'
    ) {
      const allMedia = await paginateResults((page, perPage) =>
        getTopRatedAnime(page, perPage, false, formatFilters)
      );
      if (allMedia.length === 0) {
        const feeds = await getFeedsFirstPage(perPage, false);
        return adapt(feeds.topRated ?? []);
      }
      return adapt(allMedia);
    }

    // support both `custom:` and legacy `custom` with custom URL in config
    if (subtype.startsWith('custom:') || subtype === 'custom') {
      // If explicit spec provided (custom:username/list)
      if (subtype.startsWith('custom:')) {
        const spec = rawSubtype.slice('custom:'.length);
        const [userName, maybeList] = spec.split('/');
        if (!userName) return [];
        const lists = await getUserCustomLists(userName, 'ANIME');
        const picked: AniListCustomList[] = maybeList
          ? lists.filter(
              (l) => l.name.toLowerCase() === maybeList.toLowerCase()
            )
          : lists;
        let medias: AniListMedia[] = picked.flatMap(
          (l) => l.entries?.map((e) => e.media) ?? []
        );
        medias =
          mediaType === 'movie'
            ? medias.filter((m) => m?.format === 'MOVIE')
            : medias.filter(
                (m) =>
                  m?.format &&
                  tvFormats.includes(m.format as (typeof tvFormats)[number])
              );
        return adapt(medias.slice(0, perPage));
      }

      // Legacy support: use config.anilistCustomListUrl when subtype === 'custom'
      const customUrl = config.anilistCustomListUrl;
      if (typeof customUrl === 'string' && customUrl.length > 0) {
        // parse patterns like /user/{username}/animelist/{ListName} or /search/anime?params
        let u: URL | null = null;
        try {
          u = new URL(customUrl);
        } catch (e) {
          logger.error('Failed to parse AniList custom URL', {
            label: 'AniList Collections',
            url: customUrl,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        if (u) {
          const parts = u.pathname.split('/').filter(Boolean);

          // Handle search URLs: /search/anime?genres=Comedy&sort=TRENDING_DESC or /search/anime/top-100
          if (parts[0] === 'search' && parts[1] === 'anime') {
            const searchParams: Parameters<typeof searchAnime>[2] = {};

            // Handle path-based shortcuts (e.g., /search/anime/top-100, /search/anime/this-season)
            if (parts[2]) {
              const shortcut = parts[2].toLowerCase();
              const now = new Date();
              const currentMonth = now.getMonth() + 1; // 1-12
              const currentYear = now.getFullYear();

              // Helper to get current season
              const getCurrentSeason = (): string => {
                if (currentMonth >= 1 && currentMonth <= 3) return 'WINTER';
                if (currentMonth >= 4 && currentMonth <= 6) return 'SPRING';
                if (currentMonth >= 7 && currentMonth <= 9) return 'SUMMER';
                return 'FALL';
              };

              // Helper to get next season
              const getNextSeason = (): { season: string; year: number } => {
                const currentSeason = getCurrentSeason();
                if (currentSeason === 'WINTER')
                  return { season: 'SPRING', year: currentYear };
                if (currentSeason === 'SPRING')
                  return { season: 'SUMMER', year: currentYear };
                if (currentSeason === 'SUMMER')
                  return { season: 'FALL', year: currentYear };
                return { season: 'WINTER', year: currentYear + 1 };
              };

              switch (shortcut) {
                case 'trending':
                  searchParams.sort = 'TRENDING_DESC';
                  break;
                case 'this-season':
                  searchParams.season = getCurrentSeason();
                  searchParams.seasonYear = currentYear;
                  searchParams.sort = 'POPULARITY_DESC';
                  break;
                case 'next-season': {
                  const next = getNextSeason();
                  searchParams.season = next.season;
                  searchParams.seasonYear = next.year;
                  searchParams.sort = 'POPULARITY_DESC';
                  break;
                }
                case 'popular':
                  searchParams.sort = 'POPULARITY_DESC';
                  break;
                case 'top-100':
                  searchParams.sort = 'SCORE_DESC';
                  break;
              }
            }

            // Parse query parameters from URL (these override path-based shortcuts)
            const genresParam = u.searchParams.get('genres');
            if (genresParam) {
              searchParams.genres = genresParam.split(',');
            }
            const tagsParam = u.searchParams.get('tags');
            if (tagsParam) {
              searchParams.tags = tagsParam.split(',');
            }
            const seasonParam = u.searchParams.get('season');
            if (seasonParam) {
              searchParams.season = seasonParam.toUpperCase();
            }
            const seasonYearParam = u.searchParams.get('seasonYear');
            if (seasonYearParam) {
              searchParams.seasonYear = parseInt(seasonYearParam);
            }
            const yearParam = u.searchParams.get('year');
            if (yearParam) {
              searchParams.year = parseInt(yearParam);
            }
            const sortParam = u.searchParams.get('sort');
            if (sortParam) {
              searchParams.sort = sortParam.toUpperCase();
            }
            const formatParam = u.searchParams.get('format');
            if (formatParam) {
              searchParams.format = formatParam.toUpperCase();
            }
            const statusParam = u.searchParams.get('airing status');
            if (statusParam) {
              searchParams.status = statusParam.toUpperCase();
            }
            const streamingParam = u.searchParams.get('streaming on');
            if (streamingParam) {
              searchParams.licensedById = parseInt(streamingParam);
            }
            const countryParam = u.searchParams.get('country of origin');
            if (countryParam) {
              searchParams.countryOfOrigin = countryParam.toUpperCase();
            }
            const sourceParam = u.searchParams.get('source material');
            if (sourceParam) {
              searchParams.source = sourceParam.toUpperCase();
            }
            const searchParam = u.searchParams.get('search');
            if (searchParam) {
              searchParams.search = searchParam;
            }
            if (u.searchParams.get('doujin')) {
              searchParams.isLicensed = u.searchParams.get('doujin') === 'true';
            }

            // Handle year range (appears as two separate parameters)
            const yearRanges = u.searchParams.getAll('year range');
            if (yearRanges.length >= 2) {
              searchParams.startDateGreater = parseInt(yearRanges[0]) * 10000; // Convert year to FuzzyDateInt (YYYYMMDD)
              searchParams.startDateLesser = parseInt(yearRanges[1]) * 10000;
            }

            // Handle episodes range (appears as two separate parameters)
            const episodesRanges = u.searchParams.getAll('episodes');
            if (episodesRanges.length >= 2) {
              searchParams.episodes_greater = parseInt(episodesRanges[0]);
              searchParams.episodes_lesser = parseInt(episodesRanges[1]);
            }

            // Handle duration range (appears as two separate parameters)
            const durationRanges = u.searchParams.getAll('duration');
            if (durationRanges.length >= 2) {
              searchParams.duration_greater = parseInt(durationRanges[0]);
              searchParams.duration_lesser = parseInt(durationRanges[1]);
            }

            // Apply format filters based on collection media type (only if not already specified)
            if (!searchParams.format && !searchParams.formatIn) {
              if (mediaType === 'movie') {
                searchParams.format = 'MOVIE';
              } else {
                searchParams.formatIn = [
                  'TV',
                  'TV_SHORT',
                  'ONA',
                  'OVA',
                  'SPECIAL',
                ];
              }
            }

            // Fetch with pagination (same pattern as trending/popular)
            const allMedia = await paginateResults((page, perPage) =>
              searchAnime(page, perPage, searchParams)
            );
            return adapt(allMedia);
          }

          // Handle user list URLs: /user/{username}/animelist/{ListName}
          if (parts[0] === 'user' && parts[1]) {
            const userName = parts[1];
            const maybeList = parts[3];
            const lists = await getUserCustomLists(userName, 'ANIME');
            const picked: AniListCustomList[] = maybeList
              ? lists.filter(
                  (l) => l.name.toLowerCase() === maybeList.toLowerCase()
                )
              : lists;
            let medias: AniListMedia[] = picked.flatMap(
              (l) => l.entries?.map((e) => e.media) ?? []
            );
            medias =
              mediaType === 'movie'
                ? medias.filter((m) => m?.format === 'MOVIE')
                : medias.filter(
                    (m) =>
                      m?.format &&
                      tvFormats.includes(m.format as (typeof tvFormats)[number])
                  );
            return adapt(medias.slice(0, perPage));
          }
        }
      }

      return [];
    }

    // default: trending
    const allMedia = await paginateResults((page, perPage) =>
      getTrendingAnime(page, perPage, false, formatFilters)
    );
    if (allMedia.length === 0) {
      const feeds = await getFeedsFirstPage(perPage, false);
      return adapt(feeds.trending ?? []);
    }
    return adapt(allMedia);
  }

  // ---- Map ----
  public async mapSourceDataToItems(
    sourceData: CollectionSourceData[],
    config: CollectionConfig,
    plexClient?: PlexAPI,
    libraryCache?: LibraryItemsCache
  ): Promise<{ items: CollectionItem[]; missingItems?: MissingItem[] }> {
    const items: CollectionItem[] = [];
    const missing: MissingItem[] = [];

    await ensureAnimeIdsLoaded();
    const mediaType = getCollectionMediaType(config);
    const libraryIndex = buildLibraryProviderIndex(
      libraryCache,
      config.libraryId,
      mediaType
    );

    for (let i = 0; i < sourceData.length; i++) {
      const entry = sourceData[i];
      // TypeScript narrows this to AniListSourceData since we know this is anilist collection
      if (!('raw' in entry) || !('anilistId' in entry)) continue;

      const raw = entry.raw as AniListMedia;
      const anilistId = entry.anilistId ?? raw?.id;

      const displayTitle =
        raw?.title?.english ||
        raw?.title?.romaji ||
        raw?.title?.native ||
        entry.title ||
        'Unknown';

      const ids = anilistId
        ? lookupByAniList(anilistId, mediaType, raw?.idMal)
        : undefined;
      const hit =
        libraryIndex.anilist.get(String(anilistId)) ??
        findMappedAnime(libraryIndex, ids);
      const tvdbId =
        mediaType === 'tv' && ids?.tvdb ? Number(ids.tvdb) : undefined;
      const posterUrl =
        raw?.coverImage?.extraLarge || raw?.coverImage?.large || undefined;
      if (hit) {
        items.push({
          ratingKey: hit.ratingKey,
          title: hit.title || displayTitle,
          type: mediaType,
          tmdbId: ids?.tmdb ? Number(ids.tmdb) : undefined,
          tvdbId: mediaType === 'tv' ? hit.tvdbId ?? tvdbId : undefined,
          posterUrl,
          metadata: {
            libraryKey: hit.libraryKey,
            originalPosition: i + 1,
          },
        });
        continue;
      }

      const { hit: cachedLink, tmdbId: linkedTmdbId } = this.matchExternalLinks(
        libraryIndex,
        raw?.externalLinks,
        mediaType
      );
      if (cachedLink) {
        items.push({
          ratingKey: cachedLink.ratingKey,
          title: cachedLink.title,
          type: mediaType,
          tvdbId: mediaType === 'tv' ? cachedLink.tvdbId ?? tvdbId : undefined,
          posterUrl,
          metadata: {
            libraryKey: cachedLink.libraryKey,
            originalPosition: i + 1,
          },
        });
        continue;
      }
      const itemMediaType = raw?.format === 'MOVIE' ? 'movie' : 'tv';
      if (ids === null || itemMediaType !== mediaType) continue;
      const tmdbId =
        (ids && (await resolveAnimeTmdbId(ids, mediaType))) ||
        linkedTmdbId ||
        0;
      if (tmdbId > 0 || tvdbId) {
        missing.push({
          tmdbId: tmdbId > 0 ? tmdbId : 0, // Use 0 if no TMDB ID (Sonarr will use TVDB)
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
}

export default AnilistCollectionSync;

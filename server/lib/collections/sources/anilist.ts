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
import {
  ensureAnimeIdsLoaded,
  getFirstValue,
  lookupByAniList,
  lookupByMal,
  type AnimeIdsRow,
} from '@server/api/animeIds';
import type PlexAPI from '@server/api/plexapi';
import { BaseCollectionSync } from '@server/lib/collections/core/BaseCollectionSync';
import type { LibraryItemsCache } from '@server/lib/collections/core/CollectionUtilities';
import {
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
import { buildLibraryProviderIndex } from '@server/lib/collections/utils/AnimeProviderIndex';
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

    for (const m of media) {
      const anilistId = m?.id;
      let matchedRatingKey: string | undefined;

      // Check PlexAniBridge mapping first
      if (anilistId) {
        let map = lookupByAniList(anilistId);
        if (!map && m?.idMal) {
          try {
            const malId = Number(m.idMal);
            if (!Number.isNaN(malId)) {
              map = lookupByMal(malId);
            }
          } catch (e) {
            // ignore
          }
        }

        if (map) {
          const ids = this.idsForLibrary(map, mediaType);
          matchedRatingKey = this.findCachedMatch(libraryIndex, ids)?.ratingKey;
        }
      }

      if (!matchedRatingKey) {
        // Check external links (TMDb/IMDb)
        matchedRatingKey = this.findCachedMatch(
          libraryIndex,
          this.idsFromExternalLinks(m.externalLinks, mediaType)
        )?.ratingKey;
      }
      if (matchedRatingKey) seenRatingKeys.add(matchedRatingKey);
    }

    return seenRatingKeys.size;
  }

  private idsForLibrary(row: AnimeIdsRow, mediaType: 'movie' | 'tv') {
    const tmdb =
      mediaType === 'tv' ? row.tmdb_show_id : getFirstValue(row.tmdb_movie_id);
    return {
      tmdb: tmdb != null ? String(tmdb) : undefined,
      tvdb:
        mediaType === 'tv' && row.tvdb_id != null
          ? String(row.tvdb_id)
          : undefined,
      imdb:
        mediaType === 'tv'
          ? getFirstValue(row.imdb_id)?.toLowerCase()
          : undefined,
    };
  }

  private findCachedMatch(
    index: ProviderIndex,
    ids: Partial<Record<keyof ProviderIndex, string>>
  ) {
    for (const provider of ['tvdb', 'tmdb', 'imdb'] as const) {
      const id = ids[provider];
      const hit = id ? index[provider].get(id) : undefined;
      if (hit) return hit;
    }
  }

  private idsFromExternalLinks(
    links: AniListMedia['externalLinks'],
    mediaType: 'movie' | 'tv'
  ) {
    const tmdbLink = links?.find(
      (link) =>
        (link.site || '').toUpperCase().includes('TMDB') ||
        /themoviedb\.org/i.test(link.url || '')
    );
    const imdbLink = links?.find(
      (link) =>
        (link.site || '').toUpperCase() === 'IMDB' ||
        /imdb\.com/i.test(link.url || '')
    );
    const tmdb = tmdbLink?.url?.match(/\/(tv|movie)\/(\d+)/i);
    return {
      tmdb: tmdb?.[1].toLowerCase() === mediaType ? tmdb[2] : undefined,
      imdb: imdbLink?.url?.match(/(tt\d{6,})/i)?.[1].toLowerCase(),
    };
  }

  private async findPlexMatch(
    plexClient: PlexAPI | undefined,
    ids: Partial<Record<keyof ProviderIndex, string>>,
    mediaType: 'movie' | 'tv'
  ) {
    if (!plexClient || !ids) return;
    for (const provider of ['tvdb', 'tmdb', 'imdb'] as const) {
      const id = ids[provider];
      if (!id) continue;
      const hit = await this.plexLookupByGuid(
        plexClient,
        provider,
        id,
        mediaType
      );
      if (hit) return hit;
    }
  }

  // Try a direct Plex lookup by GUID if available on your PlexAPI
  private async plexLookupByGuid(
    plexClient: PlexAPI | undefined,
    provider: 'tmdb' | 'imdb' | 'tvdb',
    id: string,
    mediaType: 'movie' | 'tv'
  ): Promise<{ ratingKey: string; title: string } | null> {
    const guid = `${provider}://${id}`;
    try {
      // PlexAPI may have optional methods for GUID lookups
      const plexClientWithMethods = plexClient as PlexAPI & {
        findByGuid?: (
          guid: string,
          mediaType: string
        ) => Promise<{ ratingKey: string; title: string } | null>;
      };
      const fn = plexClientWithMethods?.findByGuid;
      if (typeof fn === 'function') {
        const hit = await fn.call(plexClient, guid, mediaType);
        if (hit?.ratingKey) {
          return { ratingKey: hit.ratingKey, title: hit.title || '' };
        }
      }
    } catch (e) {
      logger.debug('Plex GUID lookup failed', {
        provider,
        id,
        mediaType,
        error: String(e),
      });
    }
    return null;
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
      ? buildLibraryProviderIndex(libraryCache, config.libraryId)
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

    const targetLibraryId = Array.isArray(config.libraryId)
      ? config.libraryId[0]
      : config.libraryId;

    // Normalize library ID to string for metadata (used by plexLookupByGuid fallbacks)
    const normalizedLibraryId: string = targetLibraryId as string;

    const {
      imdb: imdbIdx,
      tmdb: tmdbIdx,
      tvdb: tvdbIdx,
    } = buildLibraryProviderIndex(libraryCache, config.libraryId);
    const mediaType = getCollectionMediaType(config);

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

      const posterUrl =
        raw?.coverImage?.extraLarge || raw?.coverImage?.large || undefined;

      // --- A) PlexAniBridge mapping first ---
      if (anilistId) {
        let map = lookupByAniList(anilistId);
        // If no entry for this AniList id, but AniList provides idMal, try MAL fallback
        if (!map && raw?.idMal) {
          try {
            const malId = Number(raw.idMal);
            if (!Number.isNaN(malId)) {
              map = lookupByMal(malId);
            }
          } catch (e) {
            // ignore
          }
        }

        if (map) {
          // If PlexAniBridge row exists but lacks tvdb_id, try MAL->PlexAniBridge augmentation
          if (map.tvdb_id == null && raw?.idMal) {
            try {
              const malId = Number(raw.idMal);
              if (!Number.isNaN(malId)) {
                const malMap = lookupByMal(malId);
                if (malMap && map) {
                  // merge missing fields from malMap
                  map = { ...map, ...malMap };
                }
              }
            } catch (e) {
              // ignore
            }
          }

          const ids = this.idsForLibrary(map, mediaType);
          const cached = this.findCachedMatch(
            { tmdb: tmdbIdx, tvdb: tvdbIdx, imdb: imdbIdx },
            ids
          );
          const hit =
            cached ?? (await this.findPlexMatch(plexClient, ids, mediaType));
          if (hit) {
            items.push({
              ratingKey: hit.ratingKey,
              title: hit.title || displayTitle,
              type: mediaType,
              tmdbId:
                ids.tmdb && (cached || mediaType === 'movie')
                  ? Number(ids.tmdb)
                  : undefined,
              tvdbId: cached?.tvdbId,
              posterUrl,
              metadata: {
                libraryKey: cached?.libraryKey ?? normalizedLibraryId,
                originalPosition: i + 1,
              },
            });
            continue;
          }
        }
      }

      const linkIds = this.idsFromExternalLinks(raw?.externalLinks, mediaType);
      const cachedLink = this.findCachedMatch(
        { tmdb: tmdbIdx, tvdb: tvdbIdx, imdb: imdbIdx },
        linkIds
      );
      if (cachedLink) {
        items.push({
          ratingKey: cachedLink.ratingKey,
          title: cachedLink.title,
          type: mediaType,
          tvdbId: cachedLink.tvdbId,
          posterUrl,
          metadata: {
            libraryKey: cachedLink.libraryKey,
            originalPosition: i + 1,
          },
        });
        continue;
      }
      const directLink = await this.findPlexMatch(
        plexClient,
        linkIds,
        mediaType
      );
      if (directLink) {
        items.push({
          ratingKey: directLink.ratingKey,
          title: directLink.title || displayTitle,
          type: mediaType,
          posterUrl,
          metadata: {
            libraryKey: normalizedLibraryId,
            originalPosition: i + 1,
          },
        });
        continue;
      }

      // --- C) No match found - try to get TMDB ID for auto-request ---
      // Try to get TMDB ID from anime mapping or external links
      let tmdbId = 0;
      let tvdbId: number | undefined;

      if (anilistId) {
        let map = lookupByAniList(anilistId);
        if (!map && raw?.idMal) {
          const malId = Number(raw.idMal);
          if (!Number.isNaN(malId)) {
            map = lookupByMal(malId);
          }
        }
        if (map) {
          // PRIORITY 1: Check if PlexAniBridge mapping has TMDB IDs directly (instant, free)
          if (mediaType === 'tv' && map.tmdb_show_id) {
            tmdbId = Number(map.tmdb_show_id);
          } else if (mediaType === 'movie' && map.tmdb_movie_id) {
            tmdbId = Number(map.tmdb_movie_id);
          }

          // PRIORITY 2: Only if PlexAniBridge doesn't have TMDB ID, try TVDB → TMDB API lookup
          const tvdb = map.tvdb_id != null ? String(map.tvdb_id) : undefined;
          if (tvdb) {
            tvdbId = parseInt(tvdb); // Save TVDB ID for Sonarr
          }
          if (tmdbId === 0 && tvdb) {
            try {
              const TheMovieDb = (await import('@server/api/themoviedb'))
                .default;
              const tmdb = new TheMovieDb();
              const resp = await tmdb.getByExternalId({
                externalId: parseInt(tvdb),
                type: 'tvdb',
              });
              const tvResult = resp?.tv_results?.[0];
              const movieResult = resp?.movie_results?.[0];
              if (mediaType === 'tv' && tvResult?.id) {
                tmdbId = tvResult.id;
              } else if (mediaType === 'movie' && movieResult?.id) {
                tmdbId = movieResult.id;
              } else if (tvResult?.id) {
                tmdbId = tvResult.id;
              } else if (movieResult?.id) {
                tmdbId = movieResult.id;
              }
            } catch (e) {
              // TVDB → TMDB lookup failed, continue with TVDB only
            }
          }
        }
      }

      // Fallback to external links if no mapping found
      if (tmdbId === 0) {
        const tmdbIdStr = linkIds.tmdb;
        if (tmdbIdStr) {
          tmdbId = Number(tmdbIdStr) || 0;
        }
      }

      // Use anime's actual format to determine mediaType (not collection-level mediaType)
      // AniList formats: MOVIE → 'movie', TV/TV_SHORT/ONA/OVA/SPECIAL → 'tv'
      const itemMediaType: 'movie' | 'tv' =
        raw?.format === 'MOVIE' ? 'movie' : 'tv';

      // Add to missing if we have either TMDB ID or TVDB ID
      // TMDB ID preferred for Overseerr/Radarr, TVDB ID works for Sonarr
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

    return { items, missingItems: missing };
  }
}

export default AnilistCollectionSync;

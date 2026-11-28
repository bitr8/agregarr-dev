import {
  aniListIdsForMal,
  lookupByMal,
  type AnimeProviderIds,
} from '@server/api/animeIds';
import type { LibraryItemsCache } from '@server/lib/collections/core/CollectionUtilities';

/**
 * Plex GUID structure (e.g., { id: 'tmdb://12345' })
 */
export interface PlexGuid {
  id: string;
}

/**
 * Plex library item with GUID metadata
 */
export interface PlexLibraryItem {
  ratingKey: string;
  title: string;
  guid?: string | PlexGuid;
  Guid?: PlexGuid[]; // Capital G to match actual Plex API response
}

/**
 * Entry in a provider index map
 */
export interface ProviderIndexEntry {
  ratingKey: string;
  title: string;
  libraryKey: string;
  tvdbId?: number;
}

/**
 * Provider index containing maps for IMDb, TMDB, and TVDB lookups
 */
export interface ProviderIndex {
  anilist: Map<string, ProviderIndexEntry>;
  imdb: Map<string, ProviderIndexEntry>;
  tmdb: Map<string, ProviderIndexEntry>;
  tvdb: Map<string, ProviderIndexEntry>;
}

/**
 * Build provider index maps from library cache for anime matching.
 * Shared between AniList and MyAnimeList collection sources.
 *
 * Indexes library items by their TMDb, IMDb, and TVDB IDs (extracted from Plex GUIDs)
 * and also resolves MyAnimeList agent GUIDs via the AniBridge mapping.
 */
export function buildProviderIndex(
  libraryCache: LibraryItemsCache | undefined,
  mediaType: 'movie' | 'tv'
): ProviderIndex {
  const anilist = new Map<string, ProviderIndexEntry>();
  const imdb = new Map<string, ProviderIndexEntry>();
  const tmdb = new Map<string, ProviderIndexEntry>();
  const tvdb = new Map<string, ProviderIndexEntry>();

  if (!libraryCache) return { anilist, imdb, tmdb, tvdb };

  const extractGuidString = (g: string | PlexGuid | undefined): string | null =>
    typeof g === 'string' ? g : g && typeof g.id === 'string' ? g.id : null;

  const take = (guid: string | null) => (guid ? [guid] : []);

  for (const libKey of Object.keys(libraryCache)) {
    for (const it of libraryCache[libKey] || []) {
      const plexItem = it as PlexLibraryItem;
      const guidField = plexItem.guid;
      const guidsField = plexItem.Guid; // Capital G!

      const allGuidStrings: string[] = [
        ...take(extractGuidString(guidField)),
        ...(Array.isArray(guidsField)
          ? (guidsField.map(extractGuidString).filter(Boolean) as string[])
          : []),
      ];

      // Extract tvdbId for this item to include in all index entries
      let itemTvdbId: number | undefined;
      for (const g of allGuidStrings) {
        const mTvdbId = g.match(/(?:^|agents\.thetvdb:\/\/|tvdb:\/\/)(\d+)\b/i);
        if (mTvdbId) {
          itemTvdbId = parseInt(mTvdbId[1], 10);
          break;
        }
      }

      for (const g of allGuidStrings) {
        // Common forms:
        //   tmdb://12345
        //   com.plexapp.agents.themoviedb://12345?lang=en
        //   tvdb://12345
        //   com.plexapp.agents.thetvdb://12345?lang=en
        //   imdb://tt1234567
        //   com.plexapp.agents.imdb://tt1234567?lang=en
        //   com.plexapp.agents.myanimelist://12345 (anime-specific)

        const mTmdb = g.match(
          /(?:^|agents\.themoviedb:\/\/|tmdb:\/\/)(\d+)\b/i
        );
        if (mTmdb)
          tmdb.set(mTmdb[1], {
            ratingKey: it.ratingKey,
            title: it.title,
            libraryKey: libKey,
            tvdbId: itemTvdbId,
          });

        const mImdb = g.match(/(?:^|agents\.imdb:\/\/|imdb:\/\/)(tt\d{6,})\b/i);
        if (mImdb)
          imdb.set(mImdb[1].toLowerCase(), {
            ratingKey: it.ratingKey,
            title: it.title,
            libraryKey: libKey,
            tvdbId: itemTvdbId,
          });

        const mTvdb = g.match(/(?:^|agents\.thetvdb:\/\/|tvdb:\/\/)(\d+)\b/i);
        if (mTvdb)
          tvdb.set(mTvdb[1], {
            ratingKey: it.ratingKey,
            title: it.title,
            libraryKey: libKey,
            tvdbId: itemTvdbId,
          });

        // MyAnimeList Agent: com.plexapp.agents.myanimelist://{mal_id}
        const mMalAgent = g.match(/myanimelist:\/\/(\d+)/i);
        if (mMalAgent) {
          const malId = parseInt(mMalAgent[1]);
          const ids = lookupByMal(malId, mediaType);
          const hit = {
            ratingKey: it.ratingKey,
            title: it.title,
            libraryKey: libKey,
            tvdbId:
              mediaType === 'tv'
                ? itemTvdbId ?? (ids?.tvdb ? Number(ids.tvdb) : undefined)
                : undefined,
          };
          for (const id of aniListIdsForMal(malId)) anilist.set(id, hit);
          if (ids?.tmdb) tmdb.set(ids.tmdb, hit);
          if (ids?.tvdb) tvdb.set(ids.tvdb, hit);
          if (ids?.imdb) imdb.set(ids.imdb, hit);
        }
      }
    }
  }

  return { anilist, imdb, tmdb, tvdb };
}

export function requireAnimeLibraryItems(
  libraryCache: LibraryItemsCache | undefined,
  libraryId: string | string[]
) {
  const key = Array.isArray(libraryId) ? libraryId[0] : libraryId;
  const items = libraryCache?.[key];
  if (!items) {
    throw new Error(`Plex library ${key} is missing from the library cache`);
  }
  return { [key]: items };
}

export function buildLibraryProviderIndex(
  libraryCache: LibraryItemsCache | undefined,
  libraryId: string | string[],
  mediaType: 'movie' | 'tv'
): ProviderIndex {
  return buildProviderIndex(
    requireAnimeLibraryItems(libraryCache, libraryId),
    mediaType
  );
}

export function findMappedAnime(
  index: ProviderIndex,
  ids?: AnimeProviderIds | null
) {
  if (!ids) return undefined;
  return (
    (ids.tvdb ? index.tvdb.get(ids.tvdb) : undefined) ??
    (ids.tmdb ? index.tmdb.get(ids.tmdb) : undefined) ??
    (ids.imdb ? index.imdb.get(ids.imdb) : undefined)
  );
}

export async function resolveAnimeTmdbId(
  ids: AnimeProviderIds,
  type: 'movie' | 'tv'
) {
  if (ids.tmdb) return Number(ids.tmdb);
  if (!ids.tvdb) return undefined;
  try {
    const TheMovieDb = (await import('@server/api/themoviedb')).default;
    const result = await new TheMovieDb().getByExternalId({
      externalId: Number(ids.tvdb),
      type: 'tvdb',
    });
    const candidates = type === 'tv' ? result.tv_results : result.movie_results;
    return candidates?.length === 1 ? candidates[0].id : undefined;
  } catch {
    return undefined;
  }
}

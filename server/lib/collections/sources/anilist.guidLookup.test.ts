import { loadAnimeIds } from '@server/api/anibridgeV3';
import type PlexAPI from '@server/api/plexapi';
import type { CollectionConfig } from '@server/lib/settings';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/entity/CollectionMetadata', () => ({
  CollectionMetadata: class {},
}));
vi.mock('@server/entity/CollectionMissingItems', () => ({
  CollectionMissingItems: class {},
}));
vi.mock('@server/entity/PosterTemplate', () => ({ PosterTemplate: class {} }));
vi.mock('@server/entity/User', () => ({ User: class {} }));
vi.mock('@server/api/imdbRatings', () => ({ default: class {} }));
vi.mock('@server/lib/cache', () => ({ default: { getCache: vi.fn() } }));
vi.mock('@server/lib/posterStorage', () => ({ generatePoster: vi.fn() }));
vi.mock('@server/lib/collections/services/ServiceUserManager', () => ({
  serviceUserManager: {},
}));
vi.mock('@server/lib/collections/utils/TemplateEngine', () => ({
  templateEngine: { processTemplate: (t: string) => t },
}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    globalExclusions: { movies: [], shows: [] },
    plex: {
      collectionConfigs: [],
      libraries: [
        { key: '1', type: 'show' },
        { key: '2', type: 'movie' },
      ],
    },
  }),
}));

import { AnilistCollectionSync } from './anilist';
import { MyAnimeListCollectionSync } from './myanimelist';

describe('AniList direct GUID lookup', () => {
  it("doesn't call PlexAPI.findItemByGuid, whose arguments are (libraryId, guid)", async () => {
    const findItemByGuid = vi.fn().mockResolvedValue(undefined);
    const sync = new AnilistCollectionSync() as unknown as {
      plexLookupByGuid: (
        c: PlexAPI,
        p: 'tmdb' | 'imdb' | 'tvdb',
        id: string,
        m: 'movie' | 'tv'
      ) => Promise<unknown>;
    };

    const hit = await sync.plexLookupByGuid(
      { findItemByGuid } as unknown as PlexAPI,
      'tmdb',
      '1001',
      'movie'
    );

    expect(findItemByGuid).not.toHaveBeenCalled();
    expect(hit).toBeNull();
  });
});

describe('AniList external links', () => {
  const config = { libraryId: '1' } as CollectionConfig;
  const linkedEntry = (url: string) => ({
    anilistId: 99,
    title: 'Source title',
    raw: { format: 'TV', externalLinks: [{ site: 'TMDB', url }] },
  });

  it('ignores cached items from other libraries when the selected library is absent', async () => {
    const result = await new AnilistCollectionSync().mapSourceDataToItems(
      [linkedEntry('https://www.themoviedb.org/tv/20')],
      config,
      undefined,
      {
        '2': [
          {
            ratingKey: 'elsewhere',
            title: 'Other library',
            Guid: [{ id: 'tmdb://20' }],
          },
        ],
      }
    );
    expect(result.items).toEqual([]);
    expect(result.missingItems).toEqual([
      expect.objectContaining({ tmdbId: 20, originalPosition: 1 }),
    ]);
  });
});

describe('MyAnimeList v3 matching', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('resolves Overgeared through the MAL Plex agent in a show library', async () => {
    const episodes = { '1-12': '1-12' };
    const series = {
      'tmdb_show:324502:s1': episodes,
      'tvdb_show:478752:s1': episodes,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            $meta: { schema_version: '3.0.3' },
            'anilist:212888': series,
            'mal:64340': series,
          })
        )
      )
    );
    await loadAnimeIds();
    const result = await new MyAnimeListCollectionSync().mapSourceDataToItems(
      [
        {
          malId: 64340,
          rank: 1,
          title: 'Overgeared',
          raw: { media_type: 'tv' },
        },
      ],
      { libraryId: '1' } as CollectionConfig,
      undefined,
      {
        '1': [
          {
            ratingKey: 'show',
            title: 'Overgeared',
            Guid: [{ id: 'com.plexapp.agents.myanimelist://64340' }],
          },
        ],
      }
    );
    expect(result.items).toEqual([
      expect.objectContaining({
        ratingKey: 'show',
        type: 'tv',
        tmdbId: 324502,
        tvdbId: 478752,
      }),
    ]);
    expect(result.missingItems).toEqual([]);
  });
});

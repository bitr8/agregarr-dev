import { loadAnimeIds } from '@server/api/anibridgeV3';
import type PlexAPI from '@server/api/plexapi';
import { prefetchAllLibraryItems } from '@server/lib/collections/core/CollectionUtilities';
import { autoRequestService } from '@server/lib/collections/services/AutoRequestService';
import { handlePlaceholderCleanup } from '@server/lib/placeholders/services/PlaceholderCleanup';
import type { CollectionConfig } from '@server/lib/settings';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/lib/collections/services/AutoRequestService', () => ({
  autoRequestService: { processAutoRequests: vi.fn() },
}));
vi.mock('@server/lib/placeholders/services/PlaceholderCleanup', () => ({
  handlePlaceholderCleanup: vi.fn(),
}));
const { getExternalId } = vi.hoisted(() => ({ getExternalId: vi.fn() }));
vi.mock('@server/api/themoviedb', () => ({
  default: class {
    getByExternalId = getExternalId;
  },
}));
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

it('ignores a TMDB movie link with the same numeric ID as a Plex show', async () => {
  const result = await new AnilistCollectionSync().mapSourceDataToItems(
    [
      {
        anilistId: 99,
        title: 'Source title',
        raw: {
          format: 'TV',
          externalLinks: [
            { site: 'TMDB', url: 'https://www.themoviedb.org/movie/20' },
          ],
        },
      },
    ],
    { libraryId: '1' } as CollectionConfig,
    undefined,
    {
      '1': [
        { ratingKey: 'show', title: 'Series', Guid: [{ id: 'tmdb://20' }] },
      ],
    }
  );
  expect(result.items).toEqual([]);
  expect(result.missingItems).toEqual([]);
});

it('ignores a mapped movie ID with the same number as a Plex show', async () => {
  const animeIds = await import('@server/api/animeIds');
  const lookup = vi
    .spyOn(animeIds, 'lookupByAniList')
    .mockReturnValue({ tmdb_movie_id: 20 });
  try {
    const result = await new AnilistCollectionSync().mapSourceDataToItems(
      [{ anilistId: 99, title: 'Source title', raw: { format: 'TV' } }],
      { libraryId: '1' } as CollectionConfig,
      undefined,
      {
        '1': [
          { ratingKey: 'show', title: 'Series', Guid: [{ id: 'tmdb://20' }] },
        ],
      }
    );
    expect(result.items).toEqual([]);
    expect(result.missingItems).toEqual([]);
  } finally {
    lookup.mockRestore();
  }
});

describe('AniList external links', () => {
  const config = { libraryId: '1' } as CollectionConfig;
  const linkedEntry = (url: string) => ({
    anilistId: 99,
    title: 'Source title',
    raw: { format: 'TV', externalLinks: [{ site: 'TMDB', url }] },
  });

  it('requires one distinct same-type link for a download and one owned match for membership', async () => {
    const fromLinks = (...paths: string[]) => ({
      ...linkedEntry(''),
      raw: {
        format: 'TV',
        externalLinks: paths.map((path) => ({
          site: 'TMDB',
          url: 'https://www.themoviedb.org/' + path,
        })),
      },
    });
    const sync = new AnilistCollectionSync();
    const entries = [
      fromLinks('tv/20', 'tv/21'),
      fromLinks('movie/20', 'tv/21', 'tv/21'),
    ];
    const missing = await sync.mapSourceDataToItems(
      entries,
      config,
      undefined,
      { '1': [] }
    );
    expect(missing.missingItems).toEqual([
      expect.objectContaining({ tmdbId: 21, originalPosition: 2 }),
    ]);
    const owned = await sync.mapSourceDataToItems(
      entries.slice(0, 1),
      config,
      undefined,
      {
        '1': [
          { ratingKey: 'owned', title: 'Show', Guid: [{ id: 'tmdb://21' }] },
        ],
      }
    );
    expect(owned.items.map((item) => item.ratingKey)).toEqual(['owned']);
    expect(owned.missingItems).toEqual([]);
  });

  it('keeps the movie ID of a MAL-agent row out of the show index', async () => {
    const mappings = await import('@server/api/animeIds');
    const lookup = vi
      .spyOn(mappings, 'lookupByMal')
      .mockReturnValue({ tmdb_movie_id: 20, tmdb_show_id: 30 });
    try {
      const { items } = await new AnilistCollectionSync().mapSourceDataToItems(
        [
          linkedEntry('https://www.themoviedb.org/tv/20'),
          linkedEntry('https://www.themoviedb.org/tv/30'),
        ],
        config,
        undefined,
        {
          '1': [
            {
              ratingKey: 'series',
              title: 'Series',
              Guid: [{ id: 'com.plexapp.agents.myanimelist://7' }],
            },
          ],
        }
      );
      expect(items.map((item) => item.metadata?.originalPosition)).toEqual([2]);
    } finally {
      lookup.mockRestore();
    }
  });

  it('keeps TVDB-only series out of opposite-type and ambiguous TMDB requests', async () => {
    const mappings = await import('@server/api/animeIds');
    const lookup = vi
      .spyOn(mappings, 'lookupByAniList')
      .mockReturnValue({ tvdb_id: 99 });
    const entry = { anilistId: 1, title: 'Show', raw: { format: 'TV' } };
    try {
      for (const tv_results of [[], [{ id: 11 }, { id: 12 }]]) {
        getExternalId.mockResolvedValueOnce({
          tv_results,
          movie_results: [{ id: 777 }],
        });
        const { missingItems } =
          await new AnilistCollectionSync().mapSourceDataToItems(
            [entry],
            config,
            undefined,
            { '1': [] }
          );
        expect(missingItems).toEqual([
          expect.objectContaining({ mediaType: 'tv', tvdbId: 99, tmdbId: 0 }),
        ]);
      }
    } finally {
      lookup.mockRestore();
    }
  });

  it('stops before missing-item processing when prefetch fails, and processes a successful empty read', async () => {
    const getLibraryContents = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [] });
    const plex = {
      getLibraries: async () => [{ key: '1', type: 'show' }],
      getLibraryContents,
    } as unknown as PlexAPI;
    const sync = new AnilistCollectionSync();
    const entry = linkedEntry('https://www.themoviedb.org/tv/20');
    vi.spyOn(sync, 'fetchSourceData').mockResolvedValue([entry]);
    const mappings = await import('@server/api/animeIds');
    const ready = vi
      .spyOn(mappings, 'ensureAnimeIdsLoaded')
      .mockResolvedValue();
    const requestConfig = { ...config, searchMissingTV: true };
    vi.clearAllMocks();
    try {
      await expect(
        sync['processConfiguration'](
          requestConfig,
          plex,
          [],
          undefined,
          await prefetchAllLibraryItems(plex)
        )
      ).rejects.toThrow('Plex library 1 was unavailable');
      expect(autoRequestService.processAutoRequests).not.toHaveBeenCalled();
      expect(handlePlaceholderCleanup).not.toHaveBeenCalled();
      await sync['processConfiguration'](
        requestConfig,
        plex,
        [],
        undefined,
        await prefetchAllLibraryItems(plex)
      );
      expect(autoRequestService.processAutoRequests).toHaveBeenCalledWith(
        [expect.objectContaining({ tmdbId: 20, originalPosition: 1 })],
        requestConfig,
        'anilist'
      );
    } finally {
      ready.mockRestore();
    }
  });

  it('ignores cached items from other libraries when the selected library is absent', async () => {
    await expect(
      new AnilistCollectionSync().mapSourceDataToItems(
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
      )
    ).rejects.toThrow('Plex library 1 was unavailable');
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

import type PlexAPI from '@server/api/plexapi';
import { prefetchAllLibraryItems } from '@server/lib/collections/core/CollectionUtilities';
import { autoRequestService } from '@server/lib/collections/services/AutoRequestService';
import { handlePlaceholderCleanup } from '@server/lib/placeholders/services/PlaceholderCleanup';
import type { CollectionConfig } from '@server/lib/settings';
import { describe, expect, it, vi } from 'vitest';

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

  it.each(['1', '2'])('pages through library %s', async (libraryId) => {
    const format = libraryId === '1' ? 'TV' : 'MOVIE';
    const kind = libraryId === '1' ? 'tv' : 'movie';
    const mappings = await import('@server/api/animeIds');
    const ready = vi
      .spyOn(mappings, 'ensureAnimeIdsLoaded')
      .mockResolvedValue();
    const source = await import('@server/api/anilist');
    const fetchPage = vi
      .spyOn(source, 'getTrendingAnime')
      .mockImplementation(async (page = 1) => ({
        Page: {
          pageInfo: {
            total: 4,
            perPage: 1,
            currentPage: page,
            lastPage: 4,
            hasNextPage: page < 4,
          },
          media: [
            {
              id: [4, 212888, 6, 5][page - 1],
              title: { english: 'Series' },
              format,
              externalLinks: [
                {
                  id: page,
                  site: 'TMDB',
                  url:
                    'https://www.themoviedb.org/' +
                    kind +
                    '/' +
                    (page === 1 ? 20 : 324502),
                },
              ],
            },
          ],
        },
      }));
    try {
      const rows = await new AnilistCollectionSync().fetchSourceData(
        { ...config, libraryId, maxItems: 1 },
        undefined,
        {
          [libraryId]: [
            {
              ratingKey: 'owned',
              title: 'Overgeared',
              Guid: [{ id: 'tmdb://324502' }],
            },
          ],
          [libraryId === '1' ? '2' : '1']: [
            {
              ratingKey: 'foreign',
              title: 'Series',
              Guid: [{ id: 'tmdb://20' }],
            },
          ],
        }
      );
      expect(rows).toMatchObject(
        [4, 212888, 6].map((anilistId) => ({ anilistId }))
      );
      expect(fetchPage).toHaveBeenCalledTimes(3);
    } finally {
      fetchPage.mockRestore();
      ready.mockRestore();
    }
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
    const ambiguous = await sync.mapSourceDataToItems(
      entries.slice(0, 1),
      config,
      undefined,
      {
        '1': [20, 21].map((id) => ({
          ratingKey: String(id),
          title: 'Show',
          Guid: [{ id: 'tmdb://' + id }],
        })),
      }
    );
    expect(ambiguous).toEqual({ items: [], missingItems: [] });
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
      ).rejects.toThrow('Plex library 1 is missing from the library cache');
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
    ).rejects.toThrow('Plex library 1 is missing from the library cache');
  });
});

describe('AniBridge v2 mapping rows', () => {
  it.each([
    ['1', 'ONA', 20480, 20505, { tmdb_movie_id: 726213 }, 726213],
    ['2', 'MOVIE', 2289, 2289, { tmdb_show_id: 19697, tvdb_id: 72845 }, 19697],
  ] as const)(
    'matches the MAL agent in library %s without matching an unrelated TMDB item',
    async (libraryId, format, anilistId, malId, ids, collision) => {
      const mappings = await import('@server/api/animeIds');
      const row = { ...ids, anilist_id: anilistId, mal_id: malId };
      const byAniList = vi
        .spyOn(mappings, 'lookupByAniList')
        .mockReturnValue(row);
      const byMal = vi.spyOn(mappings, 'lookupByMal').mockReturnValue(row);
      const source = [{ anilistId, title: 'Source title', raw: { format } }];
      const wrong = {
        ratingKey: 'unrelated',
        title: 'Other title',
        Guid: [{ id: 'tmdb://' + collision }],
      };
      const agent = {
        ratingKey: 'agent',
        title: 'Own row',
        guid: 'com.plexapp.agents.myanimelist://' + malId,
      };
      const sync = new AnilistCollectionSync();
      const map = (items: (typeof wrong | typeof agent)[]) =>
        sync.mapSourceDataToItems(
          source,
          { libraryId } as CollectionConfig,
          undefined,
          { [libraryId]: items }
        );
      try {
        expect((await map([wrong])).items).toEqual([]);
        const owned = await map([agent, wrong]);
        expect(owned.items.map((item) => item.ratingKey)).toEqual(['agent']);
        expect(owned.items[0].tmdbId).toBeUndefined();
        expect(owned.missingItems).toEqual([]);
      } finally {
        byAniList.mockRestore();
        byMal.mockRestore();
      }
    }
  );

  it('resolves a split movie row only when a fallback identifies one of its movies', async () => {
    const mappings = await import('@server/api/animeIds');
    const lookup = vi.spyOn(mappings, 'lookupByAniList').mockReturnValue({
      tmdb_movie_id: [21832, 857862],
      tvdb_id: 70350,
    });
    const sync = new AnilistCollectionSync();
    const missing = async (link?: number) =>
      (
        await sync.mapSourceDataToItems(
          [
            {
              anilistId: 31,
              title: 'Film',
              raw: {
                format: 'MOVIE',
                externalLinks: link
                  ? [
                      {
                        site: 'TMDB',
                        url: 'https://www.themoviedb.org/movie/' + link,
                      },
                    ]
                  : [],
              },
            },
          ],
          { libraryId: '2' } as CollectionConfig,
          undefined,
          { '2': [] }
        )
      ).missingItems;
    try {
      getExternalId.mockResolvedValue({ movie_results: [] });
      expect(await missing()).toEqual([]);
      expect(await missing(123)).toEqual([]);
      expect(await missing(857862)).toMatchObject([{ tmdbId: 857862 }]);
      getExternalId.mockResolvedValue({ movie_results: [{ id: 21832 }] });
      const result = await missing();
      expect(result).toMatchObject([{ tmdbId: 21832 }]);
      expect(result?.[0].tvdbId).toBeUndefined();
      expect(await missing(857862)).toEqual([]);
    } finally {
      lookup.mockRestore();
      getExternalId.mockReset();
    }
  });
});

import { loadAnimeIds } from '@server/api/animeIds';
import type PlexAPI from '@server/api/plexapi';
import { prefetchAllLibraryItems } from '@server/lib/collections/core/CollectionUtilities';
import { autoRequestService } from '@server/lib/collections/services/AutoRequestService';
import { handlePlaceholderCleanup } from '@server/lib/placeholders/services/PlaceholderCleanup';
import type { CollectionConfig } from '@server/lib/settings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/lib/collections/services/AutoRequestService', () => ({
  autoRequestService: { processAutoRequests: vi.fn() },
}));
vi.mock('@server/lib/placeholders/services/PlaceholderCleanup', () => ({
  handlePlaceholderCleanup: vi.fn(),
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

beforeEach(async () => {
  const movie = { 'tmdb_movie:1': { '1': '1' } };
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            $meta: { schema_version: '3.0.3' },
            'anilist:1': movie,
            'mal:1': movie,
          })
        )
    )
  );
  await loadAnimeIds();
});
afterEach(() => vi.unstubAllGlobals());

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
describe('AniBridge collection matching', () => {
  const episodes = { '1-12': '1-12' };
  const overgeared = {
    'tmdb_show:324502:s1': episodes,
    'tvdb_show:478752:s1': episodes,
    'mal:64340': episodes,
    'anidb:20077:R': episodes,
  };
  const data = {
    $meta: { schema_version: '3.0.3' },
    'anilist:212888': overgeared,
    'mal:64340': { ...overgeared, 'anilist:212888': episodes },
    'anilist:2': {
      'tmdb_movie:324502': episodes,
      'imdb_movie:tt0123456': episodes,
    },
    'anilist:3': { 'tmdb_show:15:s1': episodes, 'tmdb_show:16:s2': episodes },
    'anilist:4': { 'tmdb_show:20:s1': episodes, 'tmdb_show:20:s2': episodes },
    'anilist:6': {
      'tmdb_show:324502:s2': episodes,
      'tvdb_show:478752:s2': episodes,
    },
    'anilist:5': { 'tmdb_show:21:s1': { '1-': null } },
  };
  const config = { libraryId: '1' } as CollectionConfig;
  const entry = (anilistId: number, idMal?: number) => ({
    anilistId,
    title: 'Source title',
    raw: { format: 'TV', idMal },
  });
  beforeEach(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(data)))
    );
    await loadAnimeIds();
  });

  it.each([
    'tmdb://324502',
    'tvdb://478752',
    'com.plexapp.agents.myanimelist://64340',
  ])(
    'matches Overgeared via %s and keeps its AniList position',
    async (guid) => {
      const sync = new AnilistCollectionSync();
      const mapped = await sync.mapSourceDataToItems(
        [entry(2), entry(212888), entry(4), entry(6)],
        config,
        undefined,
        {
          '1': [
            {
              ratingKey: 'second',
              title: 'Another series',
              Guid: [{ id: 'tmdb://20' }],
            },
            { ratingKey: 'first', title: 'Overgeared', Guid: [{ id: guid }] },
          ],
        }
      );
      const result = await sync.applyFilteringToMappedItems(mapped, config);
      expect(
        result.items.map((item) => [
          item.ratingKey,
          item.metadata?.originalPosition,
        ])
      ).toEqual([
        ['first', 2],
        ['second', 3],
      ]);
      expect(result.missingItems).toEqual([]);
    }
  );

  it('uses the MAL source for both a missing AniList row and a MAL collection', async () => {
    const cache = {
      '1': [
        {
          ratingKey: 'hit',
          title: 'Overgeared',
          Guid: [{ id: 'tvdb://478752' }],
        },
      ],
    };
    const ani = await new AnilistCollectionSync().mapSourceDataToItems(
      [entry(99, 64340)],
      config,
      undefined,
      cache
    );
    const mal = await new MyAnimeListCollectionSync().mapSourceDataToItems(
      [
        {
          malId: 64340,
          rank: 1,
          title: 'Overgeared',
          raw: { media_type: 'tv' },
        },
      ],
      config,
      undefined,
      cache
    );
    expect(ani.items[0]?.ratingKey).toBe('hit');
    expect(mal.items[0]?.ratingKey).toBe('hit');
  });

  it('resolves Overgeared through the MAL Plex agent in a MAL collection', async () => {
    const result = await new MyAnimeListCollectionSync().mapSourceDataToItems(
      [
        {
          malId: 64340,
          rank: 1,
          title: 'Overgeared',
          raw: { media_type: 'tv' },
        },
      ],
      config,
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

  it('only creates missing items for unambiguous, correctly typed IDs', async () => {
    const result = await new AnilistCollectionSync().mapSourceDataToItems(
      [entry(3, 64340), entry(5), entry(2), entry(212888)],
      config,
      undefined,
      {
        '1': [],
        '2': [
          {
            ratingKey: 'wrong-library',
            title: 'Movie',
            Guid: [{ id: 'tmdb://324502' }],
          },
        ],
      }
    );
    expect(result.items).toEqual([]);
    expect(result.missingItems).toEqual([
      expect.objectContaining({
        originalPosition: 4,
        tmdbId: 324502,
        tvdbId: 478752,
        mediaType: 'tv',
      }),
    ]);
  });

  it('requests two missing seasons once at their first source position', async () => {
    vi.clearAllMocks();
    const sync = new AnilistCollectionSync();
    vi.spyOn(sync, 'fetchSourceData').mockResolvedValue([
      entry(212888),
      entry(6),
    ]);
    const requestConfig = { ...config, searchMissingTV: true };
    await sync['processConfiguration'](
      requestConfig,
      {} as PlexAPI,
      [],
      undefined,
      { '1': [] }
    );
    expect(autoRequestService.processAutoRequests).toHaveBeenCalledWith(
      [expect.objectContaining({ tmdbId: 324502, originalPosition: 1 })],
      requestConfig,
      'anilist'
    );
  });

  it('uses a movie IMDb target in a movie library', async () => {
    const result = await new AnilistCollectionSync().mapSourceDataToItems(
      [{ ...entry(2), raw: { format: 'MOVIE' } }],
      { libraryId: '2' } as CollectionConfig,
      undefined,
      {
        '2': [
          {
            ratingKey: 'movie',
            title: 'Movie',
            Guid: [{ id: 'imdb://tt0123456' }],
          },
        ],
      }
    );
    expect(result.items[0]).toMatchObject({
      ratingKey: 'movie',
      type: 'movie',
      tmdbId: 324502,
    });
  });

  it('matches ambiguous mappings via external links but skips them for downloads', async () => {
    const linkedEntry = (anilistId: number, tmdbId: number) => ({
      ...entry(anilistId),
      raw: {
        format: 'TV',
        externalLinks: [
          { site: 'TMDB', url: `https://www.themoviedb.org/tv/${tmdbId}` },
        ],
      },
    });
    const result = await new AnilistCollectionSync().mapSourceDataToItems(
      [linkedEntry(3, 20), linkedEntry(3, 21), linkedEntry(99, 21)],
      config,
      undefined,
      {
        '1': [
          { ratingKey: 'linked', title: 'Series', Guid: [{ id: 'tmdb://20' }] },
        ],
      }
    );
    expect(result.items).toEqual([
      expect.objectContaining({
        ratingKey: 'linked',
        metadata: { libraryKey: '1', originalPosition: 1 },
      }),
    ]);
    expect(result.missingItems).toEqual([
      expect.objectContaining({ tmdbId: 21, originalPosition: 3 }),
    ]);
  });
});

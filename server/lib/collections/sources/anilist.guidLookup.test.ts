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

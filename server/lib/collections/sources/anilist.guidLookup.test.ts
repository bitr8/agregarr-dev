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

  it('continues past a foreign library hit and stops after finding the selected show', async () => {
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
              format: 'TV',
              externalLinks: [
                {
                  id: page,
                  site: 'TMDB',
                  url:
                    'https://www.themoviedb.org/tv/' +
                    (page === 1 ? 20 : 324502),
                },
              ],
            },
          ],
        },
      }));
    try {
      const rows = await new AnilistCollectionSync().fetchSourceData(
        { ...config, maxItems: 1 },
        undefined,
        {
          '1': [
            {
              ratingKey: 'owned',
              title: 'Overgeared',
              Guid: [{ id: 'tmdb://324502' }],
            },
          ],
          '2': [
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

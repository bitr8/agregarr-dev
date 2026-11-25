import type PlexAPI from '@server/api/plexapi';
import { prefetchAllLibraryItems } from '@server/lib/collections/core/CollectionUtilities';
import type { CollectionConfig } from '@server/lib/settings';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/entity/CollectionMetadata', () => ({
  CollectionMetadata: class {},
}));
vi.mock('@server/entity/PosterTemplate', () => ({ PosterTemplate: class {} }));
vi.mock('@server/entity/User', () => ({ User: class {} }));
vi.mock('@server/api/imdbRatings', () => ({ default: class {} }));
vi.mock('@server/lib/cache', () => ({
  default: { getCache: vi.fn(() => ({ data: {} })) },
}));
vi.mock('@server/lib/posterStorage', () => ({ generatePoster: vi.fn() }));
vi.mock('@server/lib/collections/services/ServiceUserManager', () => ({
  serviceUserManager: {},
}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({ plex: { collectionConfigs: [] }, save: vi.fn() }),
  getTmdbLanguage: vi.fn(async () => 'en'),
}));

import PlexAPIClass from '@server/api/plexapi';
import { TmdbCollectionSync } from './tmdb';

it('retries a failed library prefetch before classifying a TMDB movie as missing', async () => {
  const getLibraryContents = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({
      items: [
        { ratingKey: 'owned', title: 'Movie', Guid: [{ id: 'tmdb://9' }] },
      ],
    });
  const plex = {
    getLibraries: async () => [{ key: '7', type: 'movie', title: 'Movies' }],
    getLibraryContents,
  } as unknown as PlexAPI;
  const cache = await prefetchAllLibraryItems(plex);
  const map = () =>
    new TmdbCollectionSync().mapSourceDataToItems(
      [{ id: 9, title: 'Movie' }],
      { libraryId: '7' } as CollectionConfig,
      plex,
      cache
    );
  const { items, missingItems } = await map();
  expect(getLibraryContents).toHaveBeenCalledTimes(2);
  expect(items.map((item) => item.ratingKey)).toEqual(['owned']);
  expect(missingItems).toEqual([]);
  getLibraryContents.mockRejectedValueOnce(new Error('still offline'));
  await expect(map()).rejects.toThrow('still offline');
});

describe('getLibraryMovies without a library cache', () => {
  it('returns every movie across all Plex pages', async () => {
    const total = 1203;
    const all = Array.from({ length: total }, (_, i) => ({
      ratingKey: `rk-${i}`,
      title: `Movie ${i}`,
      type: 'movie',
      Guid: [{ id: `tmdb://${i + 1}` }],
    }));
    const getLibraryContents = vi.fn(
      async (_id: string, o: { offset?: number; size?: number } = {}) => {
        const offset = o.offset ?? 0;
        const size = o.size ?? 50;
        return { totalSize: total, items: all.slice(offset, offset + size) };
      }
    );
    const plex = { getLibraryContents } as unknown as PlexAPI;
    plex.getAllLibraryContents =
      PlexAPIClass.prototype.getAllLibraryContents.bind(plex);

    const sync = new TmdbCollectionSync();
    const movies = await (sync as any).getLibraryMovies('7', undefined, plex);

    expect(movies).toHaveLength(total);
    expect(movies[total - 1].tmdbId).toBe(total);
  });
});

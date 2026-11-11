import type PlexAPI from '@server/api/plexapi';
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

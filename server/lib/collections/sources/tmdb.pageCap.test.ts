import type { CollectionConfig } from '@server/lib/settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { discover } = vi.hoisted(() => ({ discover: vi.fn() }));

vi.mock('@server/api/themoviedb', () => ({
  default: class {
    getDiscoverMovies = discover;
    getDiscoverTv = discover;
    getMovieTrending = discover;
    getTvTrending = discover;
  },
}));
vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
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
vi.mock('@server/lib/collections/utils/TemplateEngine', () => ({
  templateEngine: {},
}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    plex: {
      libraries: [
        { key: '4', type: 'movie' },
        { key: '5', type: 'show' },
      ],
      collectionConfigs: [],
    },
    save: vi.fn(),
  }),
  getTmdbLanguage: vi.fn(async () => 'en'),
}));

import { TmdbCollectionSync } from './tmdb';

const cfg = (
  subtype: string,
  libraryId: string,
  maxItems?: number
): CollectionConfig =>
  ({
    id: 'cfg-1',
    name: 'Stat',
    type: 'tmdb',
    subtype,
    libraryId,
    isActive: true,
    maxItems,
  } as unknown as CollectionConfig);

describe('TMDB 500-page limit', () => {
  beforeEach(() => {
    discover.mockReset();
    discover.mockImplementation(async ({ page }: { page: number }) => {
      if (page > 500) {
        throw new Error(
          '[TMDB] Failed to fetch discover movies: Request failed with status code 400'
        );
      }
      return {
        results: Array.from({ length: 20 }, (_, i) => ({ id: page * 100 + i })),
      };
    });
  });

  it.each([
    ['top', '4'],
    ['top', '5'],
    ['popular', '4'],
    ['trending', '5'],
  ])(
    '%s (library %s) with no max items stops at page 500',
    async (subtype, lib) => {
      await expect(
        new TmdbCollectionSync().fetchSourceData(cfg(subtype, lib))
      ).resolves.toBeDefined();
      const pages = discover.mock.calls.map(
        ([o]) => (o as { page: number }).page
      );
      expect(Math.max(...pages)).toBe(500);
    }
  );

  it('still stops early when max items is set', async () => {
    await new TmdbCollectionSync().fetchSourceData(cfg('top', '4', 30));
    expect(discover.mock.calls.length).toBeLessThanOrEqual(20);
  });
});

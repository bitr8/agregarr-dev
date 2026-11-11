import type { CollectionConfig } from '@server/lib/settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { discover } = vi.hoisted(() => ({ discover: vi.fn() }));

vi.mock('@server/api/themoviedb', () => ({
  default: class {
    getAdvancedDiscoverMovies = discover;
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
      libraries: [{ key: '4', type: 'movie' }],
      collectionConfigs: [],
    },
    save: vi.fn(),
  }),
  getTmdbLanguage: vi.fn(async () => 'en'),
}));

import { TmdbCollectionSync } from './tmdb';

const cfg = (maxItems: number): CollectionConfig =>
  ({
    id: 'cfg-1',
    name: 'Adv',
    type: 'tmdb',
    subtype: 'advanced_custom_tmdb',
    libraryId: '4',
    isActive: true,
    maxItems,
    tmdbAdvancedFilters: {
      filterGroups: [
        {
          id: 'g1',
          operator: 'and',
          filters: [
            { id: 'f1', field: 'with_genres', operator: 'and', value: '28' },
          ],
        },
      ],
    },
  } as unknown as CollectionConfig);

describe('advanced discover paging', () => {
  beforeEach(() => {
    discover.mockReset();
    discover.mockImplementation(async ({ page }: { page: number }) => {
      if (page > 60) throw { response: { status: 400 } };
      return {
        results: Array.from({ length: 20 }, (_, i) => ({ id: page * 100 + i })),
      };
    });
  });

  it('stops early when maxItems is set', async () => {
    await new TmdbCollectionSync().fetchSourceData(cfg(7));
    expect(discover.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('keeps paging when maxItems is 0', async () => {
    await new TmdbCollectionSync().fetchSourceData(cfg(0));
    expect(discover.mock.calls.length).toBeGreaterThan(50);
  });
});

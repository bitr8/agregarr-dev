import type { CollectionConfig } from '@server/lib/settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { movies, tv } = vi.hoisted(() => ({ movies: vi.fn(), tv: vi.fn() }));

vi.mock('@server/api/themoviedb', () => ({
  default: class {
    getAdvancedDiscoverMovies = movies;
    getAdvancedDiscoverTv = tv;
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
        { key: '3', type: 'show' },
      ],
      collectionConfigs: [],
    },
    save: vi.fn(),
  }),
  getTmdbLanguage: vi.fn(async () => 'en'),
}));

import { TmdbCollectionSync } from './tmdb';

type Filter = { field: string; operator: 'and' | 'or'; value: string };

const cfg = (
  libraryId: string,
  filters: Filter[],
  extra: Record<string, unknown> = {}
): CollectionConfig =>
  ({
    id: 'cfg-1',
    name: 'Adv',
    type: 'tmdb',
    subtype: 'advanced_custom_tmdb',
    libraryId,
    isActive: true,
    maxItems: 5,
    tmdbAdvancedFilters: {
      filterGroups: [
        {
          id: 'g1',
          operator: 'and',
          filters: filters.map((f, i) => ({ id: `f${i}`, ...f })),
        },
      ],
    },
    ...extra,
  } as unknown as CollectionConfig);

const sentParams = (fn: typeof movies) =>
  fn.mock.calls[0][0] as Record<string, unknown>;

describe('advanced discover filter operators', () => {
  beforeEach(() => {
    movies.mockReset();
    tv.mockReset();
    movies.mockResolvedValue({ results: [] });
    tv.mockResolvedValue({ results: [] });
  });

  it('sends several statuses and show types as match any', async () => {
    await new TmdbCollectionSync().fetchSourceData(
      cfg('3', [
        { field: 'with_status', operator: 'and', value: '0,3' },
        { field: 'with_type', operator: 'and', value: '2,4' },
      ])
    );
    expect(sentParams(tv)).toMatchObject({
      with_status: '0|3',
      with_type: '2|4',
    });
  });

  it('sends several certifications as match any', async () => {
    await new TmdbCollectionSync().fetchSourceData(
      cfg('4', [
        { field: 'certification_country', operator: 'and', value: 'US' },
        { field: 'certification', operator: 'and', value: 'PG,R' },
      ])
    );
    expect(sentParams(movies)).toMatchObject({ certification: 'PG|R' });
  });

  it('honours match any and match all for networks and origin country', async () => {
    await new TmdbCollectionSync().fetchSourceData(
      cfg('3', [
        { field: 'with_networks', operator: 'or', value: '49,213' },
        { field: 'with_origin_country', operator: 'and', value: 'US|GB' },
      ])
    );
    expect(sentParams(tv)).toMatchObject({
      with_networks: '49|213',
      with_origin_country: 'US,GB',
    });
  });

  it('keeps TMDB order for a revenue sort', async () => {
    movies.mockResolvedValueOnce({
      results: [
        { id: 1, popularity: 1 },
        { id: 2, popularity: 50 },
        { id: 3, popularity: 9 },
      ],
    });
    const out = await new TmdbCollectionSync().fetchSourceData(
      cfg('4', [{ field: 'with_genres', operator: 'and', value: '28' }], {
        tmdbMovieSortBy: 'revenue.desc',
      })
    );
    expect(sentParams(movies)).toMatchObject({ sort_by: 'revenue.desc' });
    expect(out.map((i) => i.id)).toEqual([1, 2, 3]);
  });
});

describe('advanced discover empty groups', () => {
  beforeEach(() => {
    movies.mockReset();
    movies.mockImplementation(async (p: Record<string, unknown>) => ({
      results: p.with_genres
        ? [
            { id: 1, popularity: 5 },
            { id: 2, popularity: 4 },
          ]
        : [
            { id: 1, popularity: 5 },
            { id: 9, popularity: 99 },
          ],
    }));
  });

  const groupsCfg = (second: Record<string, unknown>) =>
    ({
      id: 'cfg-1',
      name: 'Adv',
      type: 'tmdb',
      subtype: 'advanced_custom_tmdb',
      libraryId: '4',
      isActive: true,
      maxItems: 5,
      tmdbAdvancedFilters: {
        filterGroups: [
          {
            id: 'g1',
            operator: 'and',
            filters: [
              { id: 'f1', field: 'with_genres', operator: 'and', value: '28' },
            ],
          },
          second,
        ],
      },
    } as unknown as CollectionConfig);

  it('skips a later group with only blank filters', async () => {
    const out = await new TmdbCollectionSync().fetchSourceData(
      groupsCfg({
        id: 'g2',
        operator: 'not',
        filters: [{ id: 'f2', field: '', operator: 'and', value: '' }],
      })
    );
    expect(movies).toHaveBeenCalledTimes(1);
    expect(out.map((i) => i.id)).toEqual([1, 2]);
  });

  it('skips a later group whose filters only apply to TV', async () => {
    const out = await new TmdbCollectionSync().fetchSourceData(
      groupsCfg({
        id: 'g2',
        operator: 'or',
        filters: [
          { id: 'f2', field: 'with_networks', operator: 'and', value: '49' },
        ],
      })
    );
    expect(movies).toHaveBeenCalledTimes(1);
    expect(out.map((i) => i.id)).toEqual([1, 2]);
  });
});

describe('advanced discover certification country', () => {
  beforeEach(() => {
    movies.mockReset();
    movies.mockResolvedValue({ results: [] });
  });

  it('sends US when a rating has no country', async () => {
    await new TmdbCollectionSync().fetchSourceData(
      cfg('4', [{ field: 'certification.lte', operator: 'and', value: 'PG' }])
    );
    expect(sentParams(movies)).toMatchObject({
      certification_country: 'US',
      'certification.lte': 'PG',
    });
  });

  it('keeps the chosen country', async () => {
    await new TmdbCollectionSync().fetchSourceData(
      cfg('4', [
        { field: 'certification_country', operator: 'and', value: 'GB' },
        { field: 'certification', operator: 'and', value: '15' },
      ])
    );
    expect(sentParams(movies)).toMatchObject({ certification_country: 'GB' });
  });

  it('adds no country without a rating', async () => {
    await new TmdbCollectionSync().fetchSourceData(
      cfg('4', [{ field: 'with_genres', operator: 'and', value: '28' }])
    );
    expect(sentParams(movies)).not.toHaveProperty('certification_country');
    expect(sentParams(movies)).toMatchObject({ with_genres: '28' });
  });
});

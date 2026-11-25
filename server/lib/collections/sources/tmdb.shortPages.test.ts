import type { CollectionConfig } from '@server/lib/settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { discover, getList } = vi.hoisted(() => ({
  discover: vi.fn(),
  getList: vi.fn(),
}));

vi.mock('@server/api/themoviedb', () => ({
  default: class {
    getDiscoverMovies = discover;
    getDiscoverTv = discover;
    getMovieTrending = discover;
    getTvTrending = discover;
    getList = getList;
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

import { isLastTmdbPage } from '@server/api/themoviedb/constants';
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
    tmdbCustomCollectionUrl: 'https://www.themoviedb.org/list/634',
  } as unknown as CollectionConfig);

const page = (n: number, size: number) =>
  Array.from({ length: size }, (_, i) => ({ id: n * 100 + i, title: 'x' }));

const pagesAsked = (fn: typeof discover) =>
  fn.mock.calls.map(([o]) => (o as { page: number }).page);

describe('TMDB short pages', () => {
  beforeEach(() => {
    discover.mockReset();
    getList.mockReset();
  });

  it.each([
    ['trending_day', '4'],
    ['trending_week', '5'],
    ['top', '4'],
    ['popular', '5'],
  ])('%s keeps paging past a short page', async (subtype, lib) => {
    discover.mockImplementation(async ({ page: n }: { page: number }) => ({
      results: page(n, n === 1 ? 19 : 20),
      total_pages: 3,
    }));
    const data = await new TmdbCollectionSync().fetchSourceData(
      cfg(subtype, lib)
    );
    expect(pagesAsked(discover)).toEqual([1, 2, 3]);
    expect(data).toHaveLength(59);
  });

  it('list keeps paging past a short page and stops at total_pages', async () => {
    getList.mockImplementation(async ({ page: n }: { page: number }) => ({
      items: page(n, n === 2 ? 18 : 20),
      total_pages: 3,
    }));
    const data = await new TmdbCollectionSync().fetchSourceData(
      cfg('custom', '4')
    );
    expect(pagesAsked(getList)).toEqual([1, 2, 3]);
    expect(data).toHaveLength(58);
  });

  it('list without total_pages still stops on a short page', async () => {
    getList.mockImplementation(async ({ page: n }: { page: number }) => ({
      items: page(n, n === 1 ? 20 : 7),
    }));
    await new TmdbCollectionSync().fetchSourceData(cfg('custom', '4'));
    expect(pagesAsked(getList)).toEqual([1, 2]);
  });

  it('trending without total_pages still stops on a short page', async () => {
    discover.mockImplementation(async ({ page: n }: { page: number }) => ({
      results: page(n, n === 1 ? 20 : 3),
    }));
    await new TmdbCollectionSync().fetchSourceData(cfg('trending_day', '4'));
    expect(pagesAsked(discover)).toEqual([1, 2]);
  });
});

describe('TMDB trending request failures', () => {
  beforeEach(() => {
    discover.mockReset();
  });

  it('keeps the pages already fetched when a later page fails', async () => {
    discover.mockImplementation(async ({ page: n }: { page: number }) => {
      if (n === 3) throw new Error('[TMDB] Failed to fetch all trending');
      return { results: page(n, 20), total_pages: 500 };
    });
    const data = await new TmdbCollectionSync().fetchSourceData(
      cfg('trending_week', '4')
    );
    expect(pagesAsked(discover)).toEqual([1, 2, 3]);
    expect(data).toHaveLength(40);
  });

  it('still fails the sync when the first page fails', async () => {
    discover.mockRejectedValue(
      new Error('[TMDB] Failed to fetch all trending')
    );
    await expect(
      new TmdbCollectionSync().fetchSourceData(cfg('trending_week', '5'))
    ).rejects.toThrow('trending');
  });
});

describe('isLastTmdbPage', () => {
  it.each([
    [1, { total_pages: 3 }, 19, false],
    [3, { total_pages: 3 }, 20, true],
    [1, { total_pages: 1 }, 20, true],
    [1, {}, 20, false],
    [1, {}, 19, true],
    [1, { total_pages: 0 }, 20, false],
    [1, { total_pages: NaN }, 5, true],
  ])('page %i of %j with %i results -> %s', (pg, data, len, last) => {
    expect(isLastTmdbPage(pg, data, len)).toBe(last);
  });
});

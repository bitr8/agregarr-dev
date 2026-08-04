import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    main: {},
    clientId: 'test',
  }),
}));

vi.mock('@server/lib/cache', () => ({
  default: {
    getCache: () => ({ data: undefined }),
  },
}));

vi.mock('@server/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import FlixPatrolAPI, { parsePlatformSubtype } from './flixpatrol';

describe('parsePlatformSubtype', () => {
  it.each([
    ['netflix_top_10', 'netflix', undefined],
    ['viki-tv_top_10', 'viki-tv', undefined],
    ['hbo-max_top_10', 'hbo-max', undefined],
    ['apple-tv_top_10', 'apple-tv', undefined],
    ['apple-tv-store_top_10', 'apple-tv-store', undefined],
    ['amazon-prime_top_10', 'amazon-prime', undefined],
    ['discovery-plus_top_10', 'discovery-plus', undefined],
    ['google-tv_top_10', 'google-tv', undefined],
    ['netflix-kids_top_10', 'netflix', 'kids'],
    ['amazon-prime-kids_top_10', 'amazon-prime', 'kids'],
  ])(
    '%s -> basePlatform=%s, contentFilter=%s',
    (input, expectedPlatform, expectedFilter) => {
      const { basePlatform, contentFilter } = parsePlatformSubtype(input);
      expect(basePlatform).toBe(expectedPlatform);
      expect(contentFilter).toBe(expectedFilter);
    }
  );
});

describe('FlixPatrolAPI', () => {
  describe('getAvailableCountries', () => {
    it('returns static country list with global first', async () => {
      const api = new FlixPatrolAPI();
      const countries = await api.getAvailableCountries();

      expect(countries[0]).toBe('global');
      expect(countries.length).toBeGreaterThan(100);
      expect(countries).toContain('australia');
      expect(countries).toContain('united-states');
      expect(countries).toContain('united-kingdom');
    });

    it('preserves FlixPatrol slug quirks', async () => {
      const api = new FlixPatrolAPI();
      const countries = await api.getAvailableCountries();

      expect(countries).toContain('salvador');
      expect(countries).not.toContain('el-salvador');
      expect(countries).toContain('swaziland');
      expect(countries).not.toContain('eswatini');
    });

    it('has no duplicates', async () => {
      const api = new FlixPatrolAPI();
      const countries = await api.getAvailableCountries();
      const unique = new Set(countries);

      expect(unique.size).toBe(countries.length);
    });

    it('countries are sorted (after global)', async () => {
      const api = new FlixPatrolAPI();
      const countries = await api.getAvailableCountries();
      const withoutGlobal = countries.slice(1);
      const sorted = [...withoutGlobal].sort();

      expect(withoutGlobal).toEqual(sorted);
    });
  });
});

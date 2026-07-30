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

import FlixPatrolAPI from './flixpatrol';

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

import type { CollectionConfig } from '@server/lib/settings';
import { describe, expect, it, vi } from 'vitest';

const { discover } = vi.hoisted(() => ({ discover: vi.fn() }));

vi.mock('@server/api/themoviedb', () => ({
  default: class {
    getDiscoverMovies = discover;
    getMovie = vi.fn(async () => {
      throw new Error('no details');
    });
  },
}));
vi.mock('@server/api/servarr/radarr', () => ({ default: class {} }));
vi.mock('@server/api/servarr/sonarr', () => ({ default: class {} }));
vi.mock('@server/api/trakt', () => ({ default: class {} }));
vi.mock('@server/lib/settings', () => ({ getSettings: vi.fn(() => ({})) }));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { fetchTmdbComingSoonMovies } from './comingSoonFetch';

describe('Coming Soon TMDB discover paging', () => {
  it('keeps paging past a short page and stops at total_pages', async () => {
    discover.mockImplementation(async ({ page }: { page: number }) => ({
      results: Array.from({ length: page === 1 ? 19 : 20 }, (_, i) => ({
        id: page * 100 + i,
      })),
      total_pages: 3,
    }));
    await fetchTmdbComingSoonMovies(50, {} as CollectionConfig);
    expect(
      discover.mock.calls.map(([o]) => (o as { page: number }).page)
    ).toEqual([1, 2, 3]);
  });
});

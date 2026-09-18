process.env.TZ = 'UTC';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetMovie = vi.fn();
const mockGetTvShow = vi.fn();
vi.mock('@server/api/themoviedb', () => ({
  default: class {
    getMovie = mockGetMovie;
    getTvShow = mockGetTvShow;
  },
}));

import { fetchReleaseDateInfo } from './OverlayContextBuilder';
import { deriveReleaseDateContext } from './releaseDateContext';

describe('fetchReleaseDateInfo -> deriveReleaseDateContext: daysAgoNextSeason after the premiere pointer advances', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('S5 premiered 10 days ago, next_episode_to_air is now S5E2 in 7 days', async () => {
    mockGetTvShow.mockResolvedValue({
      first_air_date: '2020-01-01',
      next_episode_to_air: {
        season_number: 5,
        episode_number: 2,
        air_date: '2026-07-18',
      },
      seasons: [
        { season_number: 4, air_date: '2025-06-06' },
        { season_number: 5, air_date: '2026-07-01' },
      ],
    });

    const info = await fetchReleaseDateInfo(999, 'show');
    if (!info) throw new Error('expected fetchReleaseDateInfo to resolve');

    const ctx = deriveReleaseDateContext(info);
    expect(ctx.daysUntilNextEpisode).toBe(7);
    expect(ctx.daysAgoNextSeason).toBe(10);
  });
});

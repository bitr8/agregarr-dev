/**
 * Unit tests for the consolidated release-schedule cache module (fork#35 Unit C,
 * C1). Covers the contract the three former consumers depended on separately:
 * cache freshness (soft TTL), status-aware empty TTL, stale-if-error that never
 * re-serves a passed event date, the failure result, in-flight de-duplication,
 * and region-scoped keys.
 *
 * TZ pinned to Sydney (the upcoming/passed classification is tz-sensitive) and
 * fake timers pinned so date bands are deterministic.
 */
process.env.TZ = 'Australia/Sydney';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSettings = vi.fn();
vi.mock('@server/lib/settings', () => ({
  getSettings: () => mockGetSettings(),
}));

const mockGetMovie = vi.fn();
const mockGetTvShow = vi.fn();
vi.mock('@server/api/themoviedb', () => ({
  default: class {
    getMovie = mockGetMovie;
    getTvShow = mockGetTvShow;
  },
}));

vi.mock('@server/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import cacheManager from '@server/lib/cache';
import { getReleaseSchedule, __clearInflightForTests } from './releaseSchedule';

// 11/07/2026 10:00 AEST (July = AEST/UTC+10, not daylight time). Dates below are
// chosen relative to this instant.
const NOW = new Date('2026-07-11T00:00:00.000Z');

const defaultSettings = {
  main: { ratingsCacheMaxDays: 30 },
  overlays: { watchProviderRegion: 'US' },
};

function tvShow(overrides: Record<string, unknown> = {}) {
  return {
    first_air_date: '2019-04-14',
    status: 'Returning Series',
    external_ids: { tvdb_id: 121361 },
    seasons: [],
    next_episode_to_air: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockGetSettings.mockReturnValue(defaultSettings);
  cacheManager.getCache('tmdb-releases').flush();
  __clearInflightForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('getReleaseSchedule — TV live fetch and cache freshness', () => {
  it('returns fresh next-episode data from a live fetch, then serves the cache within soft TTL', async () => {
    mockGetTvShow.mockResolvedValue(
      tvShow({
        next_episode_to_air: {
          air_date: '2026-07-18',
          season_number: 5,
          episode_number: 3,
        },
      })
    );

    const first = await getReleaseSchedule(555, 'show', { year: 2019 });
    expect(first.kind).toBe('data');
    if (first.kind !== 'data') throw new Error('unreachable');
    expect(first.source).toBe('live');
    expect(first.info.nextEpisodeAirDate).toBe('2026-07-18');
    expect(first.info.seasonNumber).toBe(5);
    expect(first.info.episodeNumber).toBe(3);
    expect(first.info.tvdbId).toBe(121361);
    expect(first.tmdbStatus).toBe('Returning Series');

    // Second call five minutes later: cache hit, no second TMDB call.
    vi.setSystemTime(new Date(NOW.getTime() + 5 * 60 * 1000));
    const second = await getReleaseSchedule(555, 'show', { year: 2019 });
    expect(second.kind).toBe('data');
    if (second.kind !== 'data') throw new Error('unreachable');
    expect(second.source).toBe('cache');
    expect(mockGetTvShow).toHaveBeenCalledTimes(1);
  });

  it('refetches once the record is soft-stale (episode 4 days out -> 12 h soft TTL)', async () => {
    mockGetTvShow.mockResolvedValue(
      tvShow({
        next_episode_to_air: {
          air_date: '2026-07-15',
          season_number: 5,
          episode_number: 3,
        },
      })
    );

    await getReleaseSchedule(555, 'show', { year: 2019 });
    // 13 h later: past the 12 h soft TTL for the 1-7 d band -> refetch.
    vi.setSystemTime(new Date(NOW.getTime() + 13 * 60 * 60 * 1000));
    const refetched = await getReleaseSchedule(555, 'show', { year: 2019 });
    expect(refetched.kind).toBe('data');
    if (refetched.kind !== 'data') throw new Error('unreachable');
    expect(refetched.source).toBe('live');
    expect(mockGetTvShow).toHaveBeenCalledTimes(2);
  });

  it('falls back to the earliest upcoming TMDB season as a premiere when there is no next_episode_to_air', async () => {
    mockGetTvShow.mockResolvedValue(
      tvShow({
        next_episode_to_air: null,
        seasons: [
          { season_number: 0, air_date: '2018-01-01' }, // special, excluded
          { season_number: 2, air_date: '2026-09-01' }, // future premiere
          { season_number: 3, air_date: '2027-09-01' },
        ],
      })
    );

    const result = await getReleaseSchedule(777, 'show', { year: 2019 });
    expect(result.kind).toBe('data');
    if (result.kind !== 'data') throw new Error('unreachable');
    expect(result.info.nextEpisodeAirDate).toBe('2026-09-01');
    expect(result.info.nextSeasonAirDate).toBe('2026-09-01');
    expect(result.info.seasonNumber).toBe(2);
    expect(result.info.episodeNumber).toBe(1);
  });
});

describe('getReleaseSchedule — status-aware empty TTL (A2)', () => {
  it('Ended show with no upcoming episode caches for 7 days (survives a 25 h gap)', async () => {
    mockGetTvShow.mockResolvedValue(
      tvShow({ status: 'Ended', next_episode_to_air: null, seasons: [] })
    );

    await getReleaseSchedule(900, 'show', { year: 2015 });
    vi.setSystemTime(new Date(NOW.getTime() + 25 * 60 * 60 * 1000));
    const later = await getReleaseSchedule(900, 'show', { year: 2015 });
    if (later.kind === 'failed') throw new Error('unreachable');
    expect(later.source).toBe('cache');
    expect(mockGetTvShow).toHaveBeenCalledTimes(1);
  });

  it('Returning show with no upcoming episode refetches after 24 h', async () => {
    mockGetTvShow.mockResolvedValue(
      tvShow({
        status: 'Returning Series',
        next_episode_to_air: null,
        seasons: [],
      })
    );

    await getReleaseSchedule(901, 'show', { year: 2015 });
    vi.setSystemTime(new Date(NOW.getTime() + 25 * 60 * 60 * 1000));
    const later = await getReleaseSchedule(901, 'show', { year: 2015 });
    if (later.kind === 'failed') throw new Error('unreachable');
    expect(later.source).toBe('live');
    expect(mockGetTvShow).toHaveBeenCalledTimes(2);
  });
});

describe('getReleaseSchedule — movies', () => {
  it('returns a release date from the simple release_date fallback', async () => {
    mockGetMovie.mockResolvedValue({
      release_date: '2026-08-01',
      release_dates: undefined,
    });

    const result = await getReleaseSchedule(42, 'movie', { year: 2026 });
    expect(result.kind).toBe('data');
    if (result.kind !== 'data') throw new Error('unreachable');
    expect(result.info.releaseDate).toBe('2026-08-01');
    expect(result.isEstimatedReleaseDate).toBe(false);
  });

  it('returns kind empty when TMDB knows the movie but has no release date', async () => {
    mockGetMovie.mockResolvedValue({
      release_date: undefined,
      release_dates: undefined,
    });

    const result = await getReleaseSchedule(43, 'movie', { year: 2026 });
    expect(result.kind).toBe('empty');
    if (result.kind !== 'empty') throw new Error('unreachable');
    expect(result.source).toBe('live');
  });
});

describe('getReleaseSchedule — stale-if-error (§4.5)', () => {
  it('serves the stale record when TMDB throws and its event date is still upcoming', async () => {
    // Prime with a next episode 14 days out (24 h soft TTL band).
    mockGetTvShow.mockResolvedValueOnce(
      tvShow({
        next_episode_to_air: {
          air_date: '2026-07-25',
          season_number: 2,
          episode_number: 1,
        },
      })
    );
    await getReleaseSchedule(555, 'show', { year: 2019 });

    // 25 h later the record is soft-stale; the refresh throws.
    vi.setSystemTime(new Date(NOW.getTime() + 25 * 60 * 60 * 1000));
    mockGetTvShow.mockRejectedValueOnce(new Error('TMDB 503'));

    const result = await getReleaseSchedule(555, 'show', { year: 2019 });
    expect(result.kind).toBe('data');
    if (result.kind !== 'data') throw new Error('unreachable');
    expect(result.source).toBe('stale');
    expect(result.info.nextEpisodeAirDate).toBe('2026-07-25');
  });

  it('refuses to re-serve a stale record whose event date has passed -> failed', async () => {
    // Prime with a next episode ~33 h out (12 h soft TTL band).
    mockGetTvShow.mockResolvedValueOnce(
      tvShow({
        next_episode_to_air: {
          air_date: '2026-07-12T09:00:00Z',
          season_number: 2,
          episode_number: 4,
        },
      })
    );
    await getReleaseSchedule(555, 'show', { year: 2019 });

    // Two days later the episode has aired AND the record is soft-stale; refresh throws.
    vi.setSystemTime(new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000));
    mockGetTvShow.mockRejectedValueOnce(new Error('TMDB 503'));

    const result = await getReleaseSchedule(555, 'show', { year: 2019 });
    expect(result.kind).toBe('failed');
  });

  it('reports failed when the fetch throws and there is no prior record', async () => {
    mockGetTvShow.mockRejectedValueOnce(new Error('TMDB 503'));
    const result = await getReleaseSchedule(123, 'show', { year: 2019 });
    expect(result.kind).toBe('failed');
  });

  it('never caches null on failure: a later successful fetch is not shadowed by a failure', async () => {
    mockGetTvShow.mockRejectedValueOnce(new Error('TMDB 503'));
    const failed = await getReleaseSchedule(321, 'show', { year: 2019 });
    expect(failed.kind).toBe('failed');

    mockGetTvShow.mockResolvedValueOnce(
      tvShow({
        next_episode_to_air: {
          air_date: '2026-07-18',
          season_number: 1,
          episode_number: 2,
        },
      })
    );
    const recovered = await getReleaseSchedule(321, 'show', { year: 2019 });
    expect(recovered.kind).toBe('data');
    if (recovered.kind !== 'data') throw new Error('unreachable');
    expect(recovered.source).toBe('live');
  });
});

describe('getReleaseSchedule — in-flight de-duplication and keying', () => {
  it('collapses concurrent identical requests into a single TMDB fetch', async () => {
    mockGetTvShow.mockResolvedValue(
      tvShow({
        next_episode_to_air: {
          air_date: '2026-07-18',
          season_number: 1,
          episode_number: 1,
        },
      })
    );

    const [a, b] = await Promise.all([
      getReleaseSchedule(555, 'show', { year: 2019 }),
      getReleaseSchedule(555, 'show', { year: 2019 }),
    ]);

    expect(a.kind).toBe('data');
    expect(b.kind).toBe('data');
    expect(mockGetTvShow).toHaveBeenCalledTimes(1);
  });

  it('keys the cache by region: a different region is a separate fetch', async () => {
    mockGetMovie.mockResolvedValue({ release_date: '2026-08-01' });

    await getReleaseSchedule(42, 'movie', { year: 2026, region: 'US' });
    await getReleaseSchedule(42, 'movie', { year: 2026, region: 'AU' });
    expect(mockGetMovie).toHaveBeenCalledTimes(2);

    // Same region again is a cache hit.
    await getReleaseSchedule(42, 'movie', { year: 2026, region: 'US' });
    expect(mockGetMovie).toHaveBeenCalledTimes(2);
  });
});

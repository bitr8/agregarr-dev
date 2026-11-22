process.env.TZ = 'Australia/Sydney';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSettings = vi.fn();
vi.mock('@server/lib/settings', () => ({
  getSettings: () => mockGetSettings(),
}));

const mockGetTvShow = vi.fn();
vi.mock('@server/api/themoviedb', () => ({
  default: class {
    getTvShow = mockGetTvShow;
  },
}));

const mockGetSeries = vi.fn();
const mockGetEpisodes = vi.fn();
vi.mock('@server/api/servarr/sonarr', () => ({
  default: class {
    getSeries = mockGetSeries;
    getEpisodesBySeries = mockGetEpisodes;
  },
}));

import { fetchSonarrEpisodeContext } from './OverlayContextBuilder';
import {
  shouldSkipOnReleaseDateFetchFailure,
  usesSonarrEpisodeSummary,
} from './releaseDateFetchPolicy';

// Yellowjackets, Sonarr 22/11/2026: S4E1 at 13:00 AEDT on 23/11.
const SERIES = { id: 66, tvdbId: 399731 };
const EPISODES = [
  {
    seasonNumber: 3,
    episodeNumber: 10,
    airDateUtc: '2025-04-14T01:00:00Z',
    finaleType: 'season',
  },
  {
    seasonNumber: 4,
    episodeNumber: 1,
    airDateUtc: '2026-11-23T02:00:00Z',
    finaleType: null,
  },
  {
    seasonNumber: 4,
    episodeNumber: 10,
    airDateUtc: '2027-01-25T02:00:00Z',
    finaleType: 'series',
  },
];
const ONE_SONARR = {
  sonarr: [{ hostname: 'sonarr', port: 8989, useSsl: false, apiKey: 'k' }],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-23T03:00:00Z')); // 14:00 AEDT
  mockGetSettings.mockReturnValue(ONE_SONARR);
  mockGetSeries.mockResolvedValue([SERIES]);
  mockGetEpisodes.mockResolvedValue(EPISODES);
  mockGetTvShow.mockResolvedValue({ external_ids: { tvdb_id: 399731 } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('fetchSonarrEpisodeContext', () => {
  it('summarises a tracked show', async () => {
    const status = { failed: false };
    const ctx = await fetchSonarrEpisodeContext(
      117488,
      399731,
      new Map(),
      status
    );
    expect(status.failed).toBe(false);
    expect(ctx).toMatchObject({
      episodesAiringToday: 1,
      todaySeasonNumber: 4,
      todayEpisodeNumber: 1,
      daysSinceLastAiredEpisode: 0,
      nextFinaleType: 'series',
      lastFinaleType: 'season',
    });
    expect(mockGetTvShow).not.toHaveBeenCalled();
  });

  it('resolves the tvdbId from TMDB when the caller has none', async () => {
    const ctx = await fetchSonarrEpisodeContext(117488, undefined, new Map());
    expect(mockGetTvShow).toHaveBeenCalledTimes(1);
    expect(ctx.episodesAiringToday).toBe(1);
  });

  it('flags a failed TMDB tvdbId lookup instead of reading it as untracked', async () => {
    mockGetTvShow.mockRejectedValue(new Error('tmdb down'));
    const status = { failed: false };
    const ctx = await fetchSonarrEpisodeContext(
      117488,
      undefined,
      new Map(),
      status
    );
    expect(ctx).toEqual({});
    expect(status.failed).toBe(true);
  });

  it('leaves every field absent for a show Sonarr does not track', async () => {
    mockGetSeries.mockResolvedValue([{ ...SERIES, tvdbId: 1 }]);
    const status = { failed: false };
    const ctx = await fetchSonarrEpisodeContext(
      117488,
      399731,
      new Map(),
      status
    );
    expect(ctx).toEqual({});
    expect(status.failed).toBe(false);
    expect(mockGetEpisodes).not.toHaveBeenCalled();
  });

  it('makes no calls without a Sonarr instance', async () => {
    mockGetSettings.mockReturnValue({ sonarr: [] });
    expect(await fetchSonarrEpisodeContext(117488, undefined)).toEqual({});
    expect(mockGetTvShow).not.toHaveBeenCalled();
    expect(mockGetSeries).not.toHaveBeenCalled();
  });

  it('flags a failed episode list and returns nothing', async () => {
    mockGetEpisodes.mockRejectedValue(new Error('sonarr down'));
    const status = { failed: false };
    const ctx = await fetchSonarrEpisodeContext(
      117488,
      399731,
      new Map(),
      status
    );
    expect(ctx).toEqual({});
    expect(status.failed).toBe(true);
  });

  it('flags a failed series list too', async () => {
    mockGetSeries.mockRejectedValue(new Error('sonarr down'));
    const status = { failed: false };
    await fetchSonarrEpisodeContext(117488, 399731, new Map(), status);
    expect(status.failed).toBe(true);
  });

  it('merges two Sonarr instances without double counting', async () => {
    mockGetSettings.mockReturnValue({
      sonarr: [
        { hostname: 'a', port: 8989, useSsl: false, apiKey: 'k' },
        { hostname: 'b', port: 8989, useSsl: false, apiKey: 'k' },
      ],
    });
    const ctx = await fetchSonarrEpisodeContext(117488, 399731, new Map());
    expect(mockGetEpisodes).toHaveBeenCalledTimes(2);
    expect(ctx.episodesAiringToday).toBe(1);
  });

  it('reuses the job cache for the same series', async () => {
    const cache = new Map();
    await fetchSonarrEpisodeContext(117488, 399731, cache);
    await fetchSonarrEpisodeContext(117488, 399731, cache);
    expect(mockGetEpisodes).toHaveBeenCalledTimes(1);
  });
});

describe('Sonarr episode summary gating', () => {
  it('fetches only when a template reads one of its fields, or fields are unknown', () => {
    expect(usesSonarrEpisodeSummary(undefined)).toBe(true);
    expect(usesSonarrEpisodeSummary(new Set(['episodesAiringToday']))).toBe(
      true
    );
    expect(usesSonarrEpisodeSummary(new Set(['daysUntilNextFinale']))).toBe(
      true
    );
    expect(usesSonarrEpisodeSummary(new Set(['daysUntilNextEpisode']))).toBe(
      false
    );
  });

  it('skips the item on a fetch failure when a template reads its fields', () => {
    expect(
      shouldSkipOnReleaseDateFetchFailure(new Set(['lastFinaleType']))
    ).toBe(true);
    expect(shouldSkipOnReleaseDateFetchFailure(new Set(['imdbRating']))).toBe(
      false
    );
  });
});

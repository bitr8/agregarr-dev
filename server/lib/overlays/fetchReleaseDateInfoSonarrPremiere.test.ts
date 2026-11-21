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

import type { ReleaseDateInfo } from './OverlayContextBuilder';
import { fetchReleaseDateInfo } from './OverlayContextBuilder';
import { deriveReleaseDateContext } from './releaseDateContext';
import { usesSonarrPremiere } from './releaseDateFetchPolicy';

// Yellowjackets, live TMDB and Sonarr 21/11/2026. TMDB dates are US calendar
// days; Sonarr has S4E1 at 13:00 AEDT on 23/11 and a special on 22/11.
const TMDB_SHOW = {
  first_air_date: '2021-11-14',
  external_ids: { tvdb_id: 399731 },
  next_episode_to_air: {
    season_number: 4,
    episode_number: 1,
    air_date: '2026-11-22',
  },
  seasons: [
    { season_number: 0, air_date: '2022-07-19' },
    { season_number: 1, air_date: '2021-11-14' },
    { season_number: 2, air_date: '2023-03-26' },
    { season_number: 3, air_date: '2025-02-16' },
    { season_number: 4, air_date: '2026-11-22' },
  ],
};
const SONARR_SERIES = {
  id: 66,
  tvdbId: 399731,
  nextAiring: '2026-11-23T02:00:00Z',
};
const SONARR_PREMIERES = [
  { seasonNumber: 1, episodeNumber: 1, airDateUtc: '2021-11-15T02:00:00Z' },
  { seasonNumber: 2, episodeNumber: 1, airDateUtc: '2023-03-27T01:00:00Z' },
  { seasonNumber: 3, episodeNumber: 1, airDateUtc: '2025-02-17T02:00:00Z' },
  { seasonNumber: 4, episodeNumber: 1, airDateUtc: '2026-11-23T02:00:00Z' },
  { seasonNumber: 0, episodeNumber: 1, airDateUtc: '2026-11-22T02:00:00Z' },
];

const PRELOADED: ReleaseDateInfo = {
  releaseDate: '2021-11-14',
  nextEpisodeAirDate: '2026-11-22',
  nextSeasonAirDate: '2026-11-22',
  seasonNumber: 4,
  episodeNumber: 1,
  lastSeasonAirDate: '2026-11-22',
  tvdbId: 399731,
};

async function ctxAt(
  iso: string,
  opts: { preload?: boolean; useSonarrPremiere?: boolean } = {}
) {
  vi.setSystemTime(new Date(iso));
  const status = { failed: false };
  const preload = opts.preload
    ? new Map([['117488:show', { ...PRELOADED }]])
    : undefined;
  const info = await fetchReleaseDateInfo(
    117488,
    'show',
    new Map(),
    preload,
    status,
    opts.useSonarrPremiere ?? true
  );
  if (!info) throw new Error('expected release info');
  return { ctx: deriveReleaseDateContext(info), status };
}

beforeEach(() => {
  vi.useFakeTimers();
  mockGetSettings.mockReturnValue({
    sonarr: [{ hostname: 'sonarr', port: 8989, useSsl: false, apiKey: 'k' }],
    overlays: {},
  });
  mockGetTvShow.mockResolvedValue(TMDB_SHOW);
  mockGetSeries.mockResolvedValue([SONARR_SERIES]);
  mockGetEpisodes.mockResolvedValue(SONARR_PREMIERES);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe.each([
  ['direct', false],
  ['preloaded', true],
])('daysAgoNextSeason from Sonarr premieres (%s path)', (_name, preload) => {
  it('22/11 Sydney: S4 has not premiered, so it still counts from S3E1', async () => {
    const { ctx } = await ctxAt('2026-11-22T01:00:00Z', { preload });
    expect(ctx.daysUntilNextSeason).toBe(1);
    expect(ctx.daysAgoNextSeason).toBe(643);
  });

  it('23/11 before airtime: premieres today, not yet aired', async () => {
    const { ctx } = await ctxAt('2026-11-23T01:00:00Z', { preload });
    expect(ctx.daysUntilNextSeason).toBe(0);
    expect(ctx.daysAgoNextSeason).toBe(644);
  });

  it('23/11 after airtime: premiered 0 days ago', async () => {
    const { ctx } = await ctxAt('2026-11-23T03:00:00Z', { preload });
    expect(ctx.daysAgoNextSeason).toBe(0);
  });

  it('flag off keeps the TMDB US date (0 a day early)', async () => {
    const { ctx } = await ctxAt('2026-11-22T01:00:00Z', {
      preload,
      useSonarrPremiere: false,
    });
    expect(ctx.daysAgoNextSeason).toBe(0);
  });

  it('show not in Sonarr keeps TMDB', async () => {
    mockGetSeries.mockResolvedValue([{ ...SONARR_SERIES, tvdbId: 1 }]);
    const { ctx } = await ctxAt('2026-11-22T01:00:00Z', { preload });
    expect(ctx.daysAgoNextSeason).toBe(0);
  });

  it('episode list failure flags the fetch as failed', async () => {
    mockGetEpisodes.mockRejectedValue(new Error('sonarr down'));
    mockGetSeries.mockResolvedValue([
      { ...SONARR_SERIES, nextAiring: undefined },
    ]);
    const { status } = await ctxAt('2026-11-22T01:00:00Z', { preload });
    expect(status.failed).toBe(true);
  });
});

describe('usesSonarrPremiere', () => {
  it('only when daysAgoNextSeason is read, or fields are unknown', () => {
    expect(usesSonarrPremiere(undefined)).toBe(true);
    expect(usesSonarrPremiere(new Set(['daysAgoNextSeason']))).toBe(true);
    expect(usesSonarrPremiere(new Set(['daysUntilNextSeason']))).toBe(false);
  });
});

describe('Sonarr premiere edge cases', () => {
  it('takes the latest premiere across Sonarr instances', async () => {
    mockGetSettings.mockReturnValue({
      sonarr: [
        { hostname: 'a', port: 8989, useSsl: false, apiKey: 'k' },
        { hostname: 'b', port: 8989, useSsl: false, apiKey: 'k' },
      ],
      overlays: {},
    });
    mockGetEpisodes
      .mockResolvedValueOnce(SONARR_PREMIERES.slice(0, 2))
      .mockResolvedValueOnce(SONARR_PREMIERES);
    const { ctx } = await ctxAt('2026-11-23T03:00:00Z');
    expect(ctx.daysAgoNextSeason).toBe(0);
  });

  it('a Sonarr premiere that aired after the fetch still counts', () => {
    vi.setSystemTime(new Date('2026-11-23T03:00:00Z'));
    const ctx = deriveReleaseDateContext({
      nextSeasonAirDate: '2026-11-23T02:00:00Z',
      lastSeasonAirDate: '2025-02-17T02:00:00Z',
      lastSeasonFromSonarr: true,
    });
    expect(ctx.daysAgoNextSeason).toBe(0);
  });

  it('a TMDB bare premiere date is ignored once Sonarr supplied the list', () => {
    vi.setSystemTime(new Date('2026-11-23T01:00:00Z'));
    const ctx = deriveReleaseDateContext({
      nextSeasonAirDate: '2026-11-22',
      lastSeasonAirDate: '2025-02-17T02:00:00Z',
      lastSeasonFromSonarr: true,
    });
    expect(ctx.daysAgoNextSeason).toBe(644);
  });
});

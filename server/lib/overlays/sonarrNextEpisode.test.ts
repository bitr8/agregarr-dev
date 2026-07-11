/**
 * Tests for the Sonarr-first next-episode logic (fork#35). TZ pinned to Sydney
 * because the "upcoming vs passed" classification is timezone-sensitive.
 */
process.env.TZ = 'Australia/Sydney';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock settings + the Sonarr API before importing the module under test.
const mockGetSettings = vi.fn();
vi.mock('@server/lib/settings', () => ({
  getSettings: () => mockGetSettings(),
}));

const mockGetSeries = vi.fn();
vi.mock('@server/api/servarr/sonarr', () => ({
  default: class {
    getSeries = mockGetSeries;
  },
}));

import {
  fetchNextEpisodeFromSonarr,
  hasUpcomingAirDate,
  resolveSonarrFirstNextEpisode,
} from './OverlayContextBuilder';

const NOW = new Date('2026-07-11T00:00:00.000Z'); // 11/07 11:00 AEST

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('hasUpcomingAirDate', () => {
  it('is true for a future date', () => {
    expect(hasUpcomingAirDate('2026-07-18')).toBe(true);
  });
  it('is true for today', () => {
    expect(hasUpcomingAirDate('2026-07-11')).toBe(true);
  });
  it('is false for a past date', () => {
    expect(hasUpcomingAirDate('2026-07-04')).toBe(false);
  });
  it('is true for a Sonarr datetime that is still future in Sydney', () => {
    // 2026-07-11T09:00:00Z = 19:00 AEST today.
    expect(hasUpcomingAirDate('2026-07-11T09:00:00Z')).toBe(true);
  });
});

describe('resolveSonarrFirstNextEpisode', () => {
  const tmdbBase = {
    releaseDate: '2020-01-01',
    nextEpisodeAirDate: '2026-07-18',
    seasonNumber: 5,
    episodeNumber: 1,
    tvdbId: 123,
  };

  it('found + upcoming: Sonarr date and numbering win', () => {
    const { info, sonarrFailed } = resolveSonarrFirstNextEpisode(tmdbBase, {
      kind: 'found',
      episode: {
        nextEpisodeAirDate: '2026-07-20T09:00:00Z',
        seasonNumber: 1,
        episodeNumber: 61,
      },
    });
    expect(sonarrFailed).toBe(false);
    expect(info.nextEpisodeAirDate).toBe('2026-07-20T09:00:00Z');
    expect(info.seasonNumber).toBe(1);
    expect(info.episodeNumber).toBe(61);
    expect(info.releaseDate).toBe('2020-01-01'); // TMDB identity kept
  });

  it('found but PAST: keeps the valid future TMDB value (HIGH fix)', () => {
    const { info, sonarrFailed } = resolveSonarrFirstNextEpisode(tmdbBase, {
      kind: 'found',
      episode: {
        nextEpisodeAirDate: '2026-07-04T09:00:00Z', // a week ago
        seasonNumber: 1,
        episodeNumber: 60,
      },
    });
    expect(sonarrFailed).toBe(false);
    expect(info.nextEpisodeAirDate).toBe('2026-07-18'); // TMDB future kept
    expect(info.seasonNumber).toBe(5);
  });

  it('failed: keeps TMDB and reports sonarrFailed (skip-guard)', () => {
    const { info, sonarrFailed } = resolveSonarrFirstNextEpisode(tmdbBase, {
      kind: 'failed',
    });
    expect(sonarrFailed).toBe(true);
    expect(info.nextEpisodeAirDate).toBe('2026-07-18');
  });

  it('none: keeps TMDB, does not flag failure', () => {
    const { info, sonarrFailed } = resolveSonarrFirstNextEpisode(tmdbBase, {
      kind: 'none',
    });
    expect(sonarrFailed).toBe(false);
    expect(info.nextEpisodeAirDate).toBe('2026-07-18');
  });

  it('backfills releaseDate from Sonarr when TMDB has none', () => {
    const { info } = resolveSonarrFirstNextEpisode(
      { tvdbId: 123 },
      {
        kind: 'found',
        episode: {
          nextEpisodeAirDate: '2026-07-20T09:00:00Z',
          seasonNumber: 2,
          episodeNumber: 1,
        },
      }
    );
    expect(info.releaseDate).toBe('2026-07-20T09:00:00Z');
  });
});

describe('fetchNextEpisodeFromSonarr aggregation', () => {
  const instance = (hostname: string) => ({
    hostname,
    port: 8989,
    useSsl: false,
    apiKey: 'k',
  });
  const seriesWithUpcoming = {
    tvdbId: 123,
    nextAiring: '2026-07-18T09:00:00Z',
    seasons: [
      {
        monitored: true,
        seasonNumber: 2,
        statistics: {
          nextAiring: '2026-07-18T09:00:00Z',
          episodeFileCount: 3,
          totalEpisodeCount: 10,
        },
      },
    ],
  };
  const seriesNoUpcoming = { tvdbId: 123, nextAiring: null, seasons: [] };

  it('no Sonarr configured -> none', async () => {
    mockGetSettings.mockReturnValue({ sonarr: [] });
    expect((await fetchNextEpisodeFromSonarr(123)).kind).toBe('none');
  });

  it('single instance with an upcoming episode -> found', async () => {
    mockGetSettings.mockReturnValue({ sonarr: [instance('a')] });
    mockGetSeries.mockResolvedValueOnce([seriesWithUpcoming]);
    const r = await fetchNextEpisodeFromSonarr(123);
    expect(r.kind).toBe('found');
    if (r.kind === 'found') {
      expect(r.episode.seasonNumber).toBe(2);
      expect(r.episode.episodeNumber).toBe(4); // fileCount 3 + 1
    }
  });

  it('single responding instance, nothing upcoming -> none', async () => {
    mockGetSettings.mockReturnValue({ sonarr: [instance('a')] });
    mockGetSeries.mockResolvedValueOnce([seriesNoUpcoming]);
    expect((await fetchNextEpisodeFromSonarr(123)).kind).toBe('none');
  });

  it('single instance throws -> failed', async () => {
    mockGetSettings.mockReturnValue({ sonarr: [instance('a')] });
    mockGetSeries.mockRejectedValueOnce(new Error('timeout'));
    expect((await fetchNextEpisodeFromSonarr(123)).kind).toBe('failed');
  });

  it('BLOCK-2: responding-empty A + failing B must be failed, not none', async () => {
    mockGetSettings.mockReturnValue({
      sonarr: [instance('a'), instance('b')],
    });
    // A responds with the series but nothing upcoming; B (which could hold the
    // upcoming episode) times out. Must NOT be reported as an authoritative none.
    mockGetSeries
      .mockResolvedValueOnce([seriesNoUpcoming])
      .mockRejectedValueOnce(new Error('timeout'));
    expect((await fetchNextEpisodeFromSonarr(123)).kind).toBe('failed');
  });

  it('a found in any instance wins over another instance failing', async () => {
    mockGetSettings.mockReturnValue({
      sonarr: [instance('a'), instance('b')],
    });
    mockGetSeries.mockResolvedValueOnce([seriesWithUpcoming]);
    // B never queried because A already returned found.
    expect((await fetchNextEpisodeFromSonarr(123)).kind).toBe('found');
  });

  it('all instances respond, series absent -> none', async () => {
    mockGetSettings.mockReturnValue({
      sonarr: [instance('a'), instance('b')],
    });
    mockGetSeries.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    expect((await fetchNextEpisodeFromSonarr(123)).kind).toBe('none');
  });
});

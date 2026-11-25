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
const mockGetEpisodes = vi.fn();
vi.mock('@server/api/servarr/sonarr', () => ({
  default: class {
    getSeries = mockGetSeries;
    getEpisodesBySeries = mockGetEpisodes;
  },
}));

import {
  fetchNextEpisodeFromSonarr,
  resolveSonarrFirstNextEpisode,
} from './OverlayContextBuilder';

const NOW = new Date('2026-07-11T00:00:00.000Z'); // 11/07 11:00 AEST

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockGetEpisodes.mockResolvedValue([
    ep(2, 4, '2026-07-18T09:00:00Z'),
    ep(2, 5, '2026-07-25T09:00:00Z'),
  ]);
});

function ep(seasonNumber: number, episodeNumber: number, airDateUtc: string) {
  return { seasonNumber, episodeNumber, airDateUtc };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
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

  it('series premiere: releaseDate takes the server-TZ day of the Sonarr instant', () => {
    const { info } = resolveSonarrFirstNextEpisode(
      {
        releaseDate: '2026-07-12',
        nextEpisodeAirDate: '2026-07-12',
        tvdbId: 1,
      },
      {
        kind: 'found',
        episode: {
          nextEpisodeAirDate: '2026-07-13T01:00:00Z', // 21:00 ET 12/07 = 11:00 AEST 13/07
          nextSeasonAirDate: '2026-07-13T01:00:00Z',
          seasonNumber: 1,
          episodeNumber: 1,
        },
      }
    );
    expect(info.releaseDate).toBe('2026-07-13');
  });

  it('series premiere far from TMDB first_air_date: TMDB releaseDate kept', () => {
    const { info } = resolveSonarrFirstNextEpisode(
      { releaseDate: '2020-01-01', tvdbId: 1 },
      {
        kind: 'found',
        episode: {
          nextEpisodeAirDate: '2026-07-13T01:00:00Z',
          seasonNumber: 1,
          episodeNumber: 1,
        },
      }
    );
    expect(info.releaseDate).toBe('2020-01-01');
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
    id: 7,
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
  // nextAiring already in the past (before NOW = 2026-07-11): a stale Sonarr DB
  // that has not yet advanced past a just-aired episode.
  const seriesPastAiring = {
    tvdbId: 123,
    nextAiring: '2026-07-04T09:00:00Z',
    seasons: [
      {
        monitored: true,
        seasonNumber: 1,
        statistics: {
          nextAiring: '2026-07-04T09:00:00Z',
          episodeFileCount: 59,
          totalEpisodeCount: 60,
        },
      },
    ],
  };

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
      expect(r.episode.episodeNumber).toBe(4); // from the episode list, not fileCount + 1
      expect(r.episode.nextSeasonAirDate).toBeUndefined();
    }
  });

  it('Yellowjackets shape: a file already in the season, next airing is E1 -> premiere', async () => {
    mockGetSettings.mockReturnValue({ sonarr: [instance('a')] });
    mockGetSeries.mockResolvedValueOnce([
      {
        ...seriesWithUpcoming,
        seasons: [
          {
            monitored: true,
            seasonNumber: 4,
            statistics: {
              nextAiring: '2026-07-18T09:00:00Z',
              episodeFileCount: 1,
              totalEpisodeCount: 10,
            },
          },
        ],
      },
    ]);
    mockGetEpisodes.mockResolvedValueOnce([
      ep(4, 1, '2026-07-18T09:00:00Z'),
      ep(4, 2, '2026-07-25T09:00:00Z'),
    ]);
    const r = await fetchNextEpisodeFromSonarr(123);
    expect(r.kind).toBe('found');
    if (r.kind === 'found') {
      expect(r.episode.seasonNumber).toBe(4);
      expect(r.episode.episodeNumber).toBe(1);
      expect(r.episode.nextSeasonAirDate).toBe('2026-07-18T09:00:00Z');
    }
  });

  it('daily soap with large gaps: episode number comes from the list', async () => {
    mockGetSettings.mockReturnValue({ sonarr: [instance('a')] });
    mockGetSeries.mockResolvedValueOnce([seriesWithUpcoming]);
    mockGetEpisodes.mockResolvedValueOnce([
      ep(42, 185, '2026-07-17T09:00:00Z'),
      ep(42, 186, '2026-07-18T09:00:00Z'),
    ]);
    const r = await fetchNextEpisodeFromSonarr(123);
    if (r.kind !== 'found') throw new Error('expected found');
    expect(r.episode.seasonNumber).toBe(42);
    expect(r.episode.episodeNumber).toBe(186);
  });

  it('lowest season above 0 wins when several episodes share the airing', async () => {
    mockGetSettings.mockReturnValue({ sonarr: [instance('a')] });
    mockGetSeries.mockResolvedValueOnce([seriesWithUpcoming]);
    mockGetEpisodes.mockResolvedValueOnce([
      ep(0, 1, '2026-07-18T09:00:00Z'),
      ep(3, 2, '2026-07-18T09:00:00Z'),
      ep(2, 9, '2026-07-18T09:00:00Z'),
    ]);
    const r = await fetchNextEpisodeFromSonarr(123);
    if (r.kind !== 'found') throw new Error('expected found');
    expect(r.episode.seasonNumber).toBe(2);
    expect(r.episode.episodeNumber).toBe(9);
  });

  it('specials-only next airing: date kept, no numbering, no premiere', async () => {
    mockGetSettings.mockReturnValue({ sonarr: [instance('a')] });
    mockGetSeries.mockResolvedValueOnce([seriesWithUpcoming]);
    mockGetEpisodes.mockResolvedValueOnce([ep(0, 1, '2026-07-18T09:00:00Z')]);
    const r = await fetchNextEpisodeFromSonarr(123);
    if (r.kind !== 'found') throw new Error('expected found');
    expect(r.episode.nextEpisodeAirDate).toBe('2026-07-18T09:00:00Z');
    expect(r.episode.seasonNumber).toBeUndefined();
    expect(r.episode.episodeNumber).toBeUndefined();
    expect(r.episode.nextSeasonAirDate).toBeUndefined();
    expect(r.episode.numberingUnmatched).toBe(false);

    const { info } = resolveSonarrFirstNextEpisode(
      { nextEpisodeAirDate: '2026-07-18', seasonNumber: 0, episodeNumber: 1 },
      r
    );
    expect(info.seasonNumber).toBeUndefined();
    expect(info.episodeNumber).toBeUndefined();
  });

  it('no episode matches nextAiring: TMDB numbering and premiere are kept', async () => {
    mockGetSettings.mockReturnValue({ sonarr: [instance('a')] });
    mockGetSeries.mockResolvedValueOnce([seriesWithUpcoming]);
    mockGetEpisodes.mockResolvedValueOnce([ep(2, 3, '2026-07-11T09:00:00Z')]);
    const r = await fetchNextEpisodeFromSonarr(123);
    if (r.kind !== 'found') throw new Error('expected found');
    expect(r.episode.numberingUnmatched).toBe(true);

    const { info } = resolveSonarrFirstNextEpisode(
      {
        nextEpisodeAirDate: '2026-07-18',
        nextSeasonAirDate: '2026-07-18',
        seasonNumber: 3,
        episodeNumber: 1,
      },
      r
    );
    expect(info.nextEpisodeAirDate).toBe('2026-07-18T09:00:00Z');
    expect(info.seasonNumber).toBe(3);
    expect(info.episodeNumber).toBe(1);
    expect(info.nextSeasonAirDate).toBe('2026-07-18');
  });

  it('no match and TMDB describes a different day: Sonarr date kept, numbering and premiere cleared', async () => {
    mockGetSettings.mockReturnValue({ sonarr: [instance('a')] });
    mockGetSeries.mockResolvedValueOnce([seriesWithUpcoming]);
    mockGetEpisodes.mockResolvedValueOnce([ep(2, 3, '2026-07-11T09:00:00Z')]);
    const r = await fetchNextEpisodeFromSonarr(123);
    if (r.kind !== 'found') throw new Error('expected found');

    const { info } = resolveSonarrFirstNextEpisode(
      {
        nextEpisodeAirDate: '2026-07-25',
        nextSeasonAirDate: '2026-07-25',
        seasonNumber: 3,
        episodeNumber: 1,
      },
      r
    );
    expect(info.nextEpisodeAirDate).toBe('2026-07-18T09:00:00Z');
    expect(info.seasonNumber).toBeUndefined();
    expect(info.episodeNumber).toBeUndefined();
    expect(info.nextSeasonAirDate).toBeUndefined();
  });

  it('episode list fetch failure -> failed, not none', async () => {
    mockGetSettings.mockReturnValue({ sonarr: [instance('a')] });
    mockGetSeries.mockResolvedValueOnce([seriesWithUpcoming]);
    mockGetEpisodes.mockRejectedValueOnce(new Error('timeout'));
    expect((await fetchNextEpisodeFromSonarr(123)).kind).toBe('failed');
  });

  it('episode list is fetched once per series per cache, and a rejection is not cached', async () => {
    mockGetSettings.mockReturnValue({ sonarr: [instance('a')] });
    const cache = new Map();
    mockGetSeries.mockResolvedValue([seriesWithUpcoming]);
    mockGetEpisodes.mockRejectedValueOnce(new Error('blip'));
    expect((await fetchNextEpisodeFromSonarr(123, cache)).kind).toBe('failed');
    expect((await fetchNextEpisodeFromSonarr(123, cache)).kind).toBe('found');
    expect((await fetchNextEpisodeFromSonarr(123, cache)).kind).toBe('found');
    expect(mockGetEpisodes).toHaveBeenCalledTimes(2);
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

  it('single instance with only a PAST nextAiring -> none (not found)', async () => {
    mockGetSettings.mockReturnValue({ sonarr: [instance('a')] });
    mockGetSeries.mockResolvedValueOnce([seriesPastAiring]);
    expect((await fetchNextEpisodeFromSonarr(123)).kind).toBe('none');
  });

  it('HIGH-2: a stale-past instance A must not shadow an upcoming instance B', async () => {
    mockGetSettings.mockReturnValue({
      sonarr: [instance('a'), instance('b')],
    });
    // A has a stale past nextAiring; B has the real upcoming episode. The loop
    // must keep looking past A and return B's found result.
    mockGetSeries
      .mockResolvedValueOnce([seriesPastAiring])
      .mockResolvedValueOnce([seriesWithUpcoming]);
    const r = await fetchNextEpisodeFromSonarr(123);
    expect(r.kind).toBe('found');
    if (r.kind === 'found') {
      expect(r.episode.nextEpisodeAirDate).toBe('2026-07-18T09:00:00Z');
      expect(r.episode.seasonNumber).toBe(2);
    }
  });

  it('first instance throws, second is found -> found', async () => {
    mockGetSettings.mockReturnValue({
      sonarr: [instance('a'), instance('b')],
    });
    mockGetSeries
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce([seriesWithUpcoming]);
    expect((await fetchNextEpisodeFromSonarr(123)).kind).toBe('found');
  });

  it('both instances throw -> failed', async () => {
    mockGetSettings.mockReturnValue({
      sonarr: [instance('a'), instance('b')],
    });
    mockGetSeries
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'));
    expect((await fetchNextEpisodeFromSonarr(123)).kind).toBe('failed');
  });

  it('stale-past A + failing B -> failed (B could hold the upcoming episode)', async () => {
    mockGetSettings.mockReturnValue({
      sonarr: [instance('a'), instance('b')],
    });
    mockGetSeries
      .mockResolvedValueOnce([seriesPastAiring])
      .mockRejectedValueOnce(new Error('timeout'));
    expect((await fetchNextEpisodeFromSonarr(123)).kind).toBe('failed');
  });

  it('all instances stale-past -> none', async () => {
    mockGetSettings.mockReturnValue({
      sonarr: [instance('a'), instance('b')],
    });
    mockGetSeries
      .mockResolvedValueOnce([seriesPastAiring])
      .mockResolvedValueOnce([seriesPastAiring]);
    expect((await fetchNextEpisodeFromSonarr(123)).kind).toBe('none');
  });
});

process.env.TZ = 'Australia/Sydney';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  fetchSonarrEpisodeContext,
  resolveSonarrFirstNextEpisode,
} from './OverlayContextBuilder';
import { latestAiredPremiere } from './releaseDateContext';
import {
  effectiveAirDateUtc,
  summariseSonarrEpisodes,
  withEffectiveAirDates,
} from './sonarrEpisodeSummary';

const NOW = new Date('2026-11-22T00:00:00Z');
const PREMIERE = '2026-11-23T02:00:00Z';
const ADDED = '2026-11-20T08:16:27Z';
const E2 = '2026-11-30T02:00:00Z';

const early = {
  seasonNumber: 4,
  episodeNumber: 1,
  airDateUtc: PREMIERE,
  hasFile: true,
  episodeFile: { dateAdded: ADDED },
};
const e2 = {
  seasonNumber: 4,
  episodeNumber: 2,
  airDateUtc: E2,
  hasFile: false,
};
const s3 = {
  seasonNumber: 3,
  episodeNumber: 10,
  airDateUtc: '2025-04-14T01:00:00Z',
  hasFile: true,
  episodeFile: { dateAdded: '2025-04-14T03:00:00Z' },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockGetSettings.mockReturnValue({
    sonarr: [{ hostname: 's', port: 8989, useSsl: false, apiKey: 'k' }],
  });
  mockGetSeries.mockResolvedValue([
    { id: 66, tvdbId: 399731, nextAiring: PREMIERE },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('effectiveAirDateUtc', () => {
  it('uses dateAdded for a future episode that already has a file', () => {
    expect(effectiveAirDateUtc(early)).toBe(ADDED);
  });

  it('leaves a future episode without a file alone', () => {
    expect(effectiveAirDateUtc({ ...early, hasFile: false })).toBe(PREMIERE);
  });

  it('leaves a past episode with a file alone', () => {
    expect(effectiveAirDateUtc(s3)).toBe(s3.airDateUtc);
  });

  it('ignores a missing or unparseable dateAdded', () => {
    expect(effectiveAirDateUtc({ ...early, episodeFile: undefined })).toBe(
      PREMIERE
    );
    expect(
      effectiveAirDateUtc({ ...early, episodeFile: { dateAdded: 'nope' } })
    ).toBe(PREMIERE);
  });

  it('ignores a dateAdded later than the scheduled air date', () => {
    expect(
      effectiveAirDateUtc({
        ...early,
        episodeFile: { dateAdded: '2026-11-25T00:00:00Z' },
      })
    ).toBe(PREMIERE);
  });
});

describe('early-arrived premiere', () => {
  const rows = withEffectiveAirDates([s3, early, e2]);

  it('summary treats it as the last aired episode, not today', () => {
    const s = summariseSonarrEpisodes(rows);
    expect(s.lastAiredSeasonNumber).toBe(4);
    expect(s.lastAiredEpisodeNumber).toBe(1);
    expect(s.lastAiredEpisodeDate).toBe(ADDED);
    expect(s.daysSinceLastAiredEpisode).toBe(2);
    expect(s.episodesAiringToday).toBe(0);
    expect(s.nextEpisodeCount).toBe(1);
  });

  it('latestAiredPremiere picks it up', () => {
    expect(latestAiredPremiere(rows)).toBe(ADDED);
    expect(latestAiredPremiere([s3, early, e2])).toBeUndefined();
  });

  it('next episode moves to E2 with no season countdown', async () => {
    mockGetEpisodes.mockResolvedValue([s3, early, e2]);
    const r = await fetchNextEpisodeFromSonarr(399731);
    expect(r).toMatchObject({
      kind: 'found',
      episode: {
        nextEpisodeAirDate: E2,
        nextSeasonAirDate: undefined,
        seasonNumber: 4,
        episodeNumber: 2,
      },
    });
  });

  it('episode context reaches the fetch path with the file option', async () => {
    mockGetEpisodes.mockResolvedValue([s3, early, e2]);
    const ctx = await fetchSonarrEpisodeContext(1, 399731);
    expect(ctx.lastAiredEpisodeNumber).toBe(1);
    expect(mockGetEpisodes).toHaveBeenCalledWith(66, {
      includeEpisodeFile: true,
    });
  });

  it('no later episode: nothing upcoming from Sonarr', async () => {
    mockGetEpisodes.mockResolvedValue([s3, early]);
    expect((await fetchNextEpisodeFromSonarr(399731)).kind).toBe('none');
  });
});

describe('regressions', () => {
  it('a no-file future premiere still counts down', async () => {
    const pending = { ...early, hasFile: false, episodeFile: undefined };
    mockGetEpisodes.mockResolvedValue([s3, pending, e2]);
    const r = await fetchNextEpisodeFromSonarr(399731);
    expect(r).toMatchObject({
      kind: 'found',
      episode: {
        nextEpisodeAirDate: PREMIERE,
        nextSeasonAirDate: PREMIERE,
        seasonNumber: 4,
        episodeNumber: 1,
      },
    });
    const s = summariseSonarrEpisodes(withEffectiveAirDates([s3, pending]));
    expect(s.lastAiredSeasonNumber).toBe(3);
  });

  it('a file with a past air date is unchanged', () => {
    expect(withEffectiveAirDates([s3])[0]).toBe(s3);
  });
});

describe('TMDB countdown after an early arrival', () => {
  const none = { kind: 'none' as const, earlyArrived: [PREMIERE] };
  const tmdb = (nextEpisodeAirDate: string, episodeNumber = 1) => ({
    releaseDate: '2021-11-14',
    nextEpisodeAirDate,
    nextSeasonAirDate: nextEpisodeAirDate,
    seasonNumber: 4,
    episodeNumber,
  });

  it('collects the scheduled instant when only early episodes remain', async () => {
    mockGetEpisodes.mockResolvedValue([s3, early]);
    expect(await fetchNextEpisodeFromSonarr(399731)).toEqual(none);
  });

  it.each(['2026-11-22', '2026-11-23'])('clears TMDB next dated %s', (date) => {
    const { info } = resolveSonarrFirstNextEpisode(tmdb(date), none);
    expect(info.nextEpisodeAirDate).toBeUndefined();
    expect(info.nextSeasonAirDate).toBeUndefined();
    expect(info.seasonNumber).toBeUndefined();
  });

  it('keeps TMDB when no episode arrived early', () => {
    const base = tmdb('2026-11-22');
    expect(resolveSonarrFirstNextEpisode(base, { kind: 'none' }).info).toEqual(
      base
    );
  });

  it('keeps TMDB when its next is a different later episode', () => {
    const base = tmdb('2026-11-30', 2);
    expect(resolveSonarrFirstNextEpisode(base, none).info).toEqual(base);
  });
});

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

interface FakeInstance {
  series?: unknown[];
  episodes?: unknown[];
  files?: Record<number, { dateAdded: string }>;
  failSeries?: boolean;
  failFile?: boolean;
}
let instances: Record<string, FakeInstance> = {};
const mockGetEpisodeFile = vi.fn();
const mockGetEpisodesCall = vi.fn();
vi.mock('@server/api/servarr/sonarr', () => ({
  default: class {
    private readonly host: string;
    constructor(opts: { url: string }) {
      this.host = new URL(opts.url).hostname;
    }
    async getSeries() {
      const i = instances[this.host];
      if (i.failSeries) throw new Error('down');
      return i.series ?? [];
    }
    async getEpisodesBySeries(...args: unknown[]) {
      mockGetEpisodesCall(...args);
      return instances[this.host].episodes ?? [];
    }
    async getEpisodeFile(id: number) {
      mockGetEpisodeFile(this.host, id);
      const i = instances[this.host];
      if (i.failFile) throw new Error('file down');
      return i.files?.[id];
    }
  },
}));

import {
  fetchNextEpisodeFromSonarr,
  fetchReleaseDateInfo,
  fetchSonarrEpisodeContext,
  resolveSonarrFirstNextEpisode,
} from './OverlayContextBuilder';
import {
  deriveReleaseDateContext,
  latestAiredPremiere,
} from './releaseDateContext';
import {
  effectiveAirDateUtc,
  mergeSonarrEpisodes,
  summariseSonarrEpisodes,
  withEffectiveAirDates,
  type SonarrEpisodeRow,
} from './sonarrEpisodeSummary';

const PREMIERE = '2026-11-23T02:00:00Z';
const ADDED = '2026-11-20T08:16:27Z';
const E2 = '2026-11-30T02:00:00Z';

const early = () => ({
  seasonNumber: 4,
  episodeNumber: 1,
  airDateUtc: PREMIERE,
  hasFile: true,
  episodeFileId: 501,
  episodeFile: { dateAdded: ADDED },
});
const e2 = () => ({
  seasonNumber: 4,
  episodeNumber: 2,
  airDateUtc: E2,
  hasFile: false,
});
const s3 = () => ({
  seasonNumber: 3,
  episodeNumber: 10,
  airDateUtc: '2025-04-14T01:00:00Z',
  hasFile: true,
  episodeFileId: 301,
});
const rawEarly = () => ({
  seasonNumber: 4,
  episodeNumber: 1,
  airDateUtc: PREMIERE,
  hasFile: true,
  episodeFileId: 501,
});
const SERIES = () => ({ id: 66, tvdbId: 399731, nextAiring: PREMIERE });
const ONE_HOST = [{ hostname: 'hd', port: 8989, useSsl: false, apiKey: 'k' }];
const TWO_HOSTS = [
  ...ONE_HOST,
  { hostname: 'uhd', port: 8989, useSsl: false, apiKey: 'k' },
];

const TMDB_SHOW = () => ({
  first_air_date: '2021-11-14',
  external_ids: { tvdb_id: 399731 },
  next_episode_to_air: {
    season_number: 4,
    episode_number: 1,
    air_date: '2026-11-22',
  },
  seasons: [
    { season_number: 3, air_date: '2025-02-16' },
    { season_number: 4, air_date: '2026-11-22' },
  ],
});

function setHosts(hosts: typeof ONE_HOST) {
  mockGetSettings.mockReturnValue({ sonarr: hosts, overlays: {} });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-22T12:45:00Z'));
  setHosts(ONE_HOST);
  instances = {
    hd: {
      series: [SERIES()],
      episodes: [s3(), rawEarly(), e2()],
      files: { 501: { dateAdded: ADDED } },
    },
  };
  mockGetTvShow.mockResolvedValue(TMDB_SHOW());
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('effectiveAirDateUtc', () => {
  it('uses dateAdded for a future episode that already has a file', () => {
    expect(effectiveAirDateUtc(early())).toBe(ADDED);
  });

  it('leaves a future episode without a file alone', () => {
    expect(effectiveAirDateUtc({ ...early(), hasFile: false })).toBe(PREMIERE);
  });

  it('leaves a past episode with a file alone', () => {
    expect(
      effectiveAirDateUtc({
        ...s3(),
        episodeFile: { dateAdded: '2025-04-14T03:00:00Z' },
      })
    ).toBe(s3().airDateUtc);
  });

  it('ignores a missing or unparseable dateAdded', () => {
    expect(effectiveAirDateUtc({ ...early(), episodeFile: undefined })).toBe(
      PREMIERE
    );
    expect(
      effectiveAirDateUtc({ ...early(), episodeFile: { dateAdded: 'nope' } })
    ).toBe(PREMIERE);
  });

  it('ignores a dateAdded later than the scheduled air date', () => {
    expect(
      effectiveAirDateUtc({
        ...early(),
        episodeFile: { dateAdded: '2026-11-25T00:00:00Z' },
      })
    ).toBe(PREMIERE);
  });
});

describe('early-arrived premiere', () => {
  it('summary treats it as the last aired episode, not today', () => {
    const s = summariseSonarrEpisodes(
      withEffectiveAirDates([s3(), early(), e2()])
    );
    expect(s.lastAiredSeasonNumber).toBe(4);
    expect(s.lastAiredEpisodeNumber).toBe(1);
    expect(s.lastAiredEpisodeDate).toBe(ADDED);
    expect(s.daysSinceLastAiredEpisode).toBe(2);
    expect(s.episodesAiringToday).toBe(0);
    expect(s.nextEpisodeCount).toBe(1);
  });

  it('latestAiredPremiere picks it up', () => {
    expect(latestAiredPremiere(withEffectiveAirDates([s3(), early()]))).toBe(
      ADDED
    );
    expect(latestAiredPremiere([s3(), early()])).toBeUndefined();
  });

  it('next episode moves to E2 with no season countdown', async () => {
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

  it('episode context reaches the fetch path', async () => {
    const ctx = await fetchSonarrEpisodeContext(1, 399731);
    expect(ctx.lastAiredEpisodeNumber).toBe(1);
  });

  it('looks up the file only for future episodes that have one', async () => {
    await fetchNextEpisodeFromSonarr(399731);
    expect(mockGetEpisodeFile).toHaveBeenCalledTimes(1);
    expect(mockGetEpisodeFile).toHaveBeenCalledWith('hd', 501);
    expect(mockGetEpisodesCall).toHaveBeenCalledWith(66);
  });

  it('a failed file lookup falls back to the scheduled date', async () => {
    instances.hd.failFile = true;
    expect(await fetchNextEpisodeFromSonarr(399731)).toMatchObject({
      kind: 'found',
      episode: {
        nextEpisodeAirDate: PREMIERE,
        seasonNumber: 4,
        episodeNumber: 1,
      },
    });
  });

  it('only early episodes left: none carrying the arrivals', async () => {
    instances.hd.episodes = [s3(), rawEarly()];
    expect(await fetchNextEpisodeFromSonarr(399731)).toEqual({
      kind: 'none',
      earlyArrived: [
        { seasonNumber: 4, episodeNumber: 1, scheduledAirDateUtc: PREMIERE },
      ],
    });
  });
});

describe('regressions', () => {
  it('a no-file future premiere still counts down', async () => {
    instances.hd.episodes = [s3(), { ...rawEarly(), hasFile: false }, e2()];
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
    expect(mockGetEpisodeFile).not.toHaveBeenCalled();
  });

  it('a file with a past air date is unchanged', () => {
    const row = s3();
    expect(withEffectiveAirDates([row])[0]).toBe(row);
  });
});

describe('TMDB countdown after an early arrival', () => {
  const arrivals = [
    { seasonNumber: 4, episodeNumber: 1, scheduledAirDateUtc: PREMIERE },
  ];
  const none = { kind: 'none' as const, earlyArrived: arrivals };
  const tmdb = (
    nextEpisodeAirDate: string,
    numbering: { season?: number; episode?: number } = {
      season: 4,
      episode: 1,
    }
  ) => ({
    releaseDate: '2021-11-14',
    nextEpisodeAirDate,
    nextSeasonAirDate: nextEpisodeAirDate,
    seasonNumber: numbering.season,
    episodeNumber: numbering.episode,
  });

  it.each(['2026-11-22', '2026-11-23'])(
    'clears the same episode dated %s',
    (date) => {
      const { info } = resolveSonarrFirstNextEpisode(tmdb(date), none);
      expect(info.nextEpisodeAirDate).toBeUndefined();
      expect(info.nextSeasonAirDate).toBeUndefined();
      expect(info.seasonNumber).toBeUndefined();
    }
  );

  it('keeps TMDB when no episode arrived early', () => {
    const base = tmdb('2026-11-22');
    expect(resolveSonarrFirstNextEpisode(base, { kind: 'none' }).info).toEqual(
      base
    );
  });

  it('keeps TMDB when its next is a different later episode', () => {
    const base = tmdb('2026-11-30', { season: 4, episode: 2 });
    expect(resolveSonarrFirstNextEpisode(base, none).info).toEqual(base);
  });

  it('keeps TMDB for another episode on the same day', () => {
    const base = tmdb('2026-11-22', { season: 4, episode: 2 });
    expect(resolveSonarrFirstNextEpisode(base, none).info).toEqual(base);
  });

  it('keeps TMDB when it carries no numbering', () => {
    const base = tmdb('2026-11-22', {});
    expect(resolveSonarrFirstNextEpisode(base, none).info).toEqual(base);
  });
});

describe('fetchReleaseDateInfo (Yellowjackets shape)', () => {
  const run = async (preload = false) => {
    const status = { failed: false };
    const preloaded = preload
      ? new Map([
          [
            '1:show',
            {
              releaseDate: '2021-11-14',
              nextEpisodeAirDate: '2026-11-22',
              nextSeasonAirDate: '2026-11-22',
              seasonNumber: 4,
              episodeNumber: 1,
              lastSeasonAirDate: '2026-11-22',
              tvdbId: 399731,
            },
          ],
        ])
      : undefined;
    const info = await fetchReleaseDateInfo(
      1,
      'show',
      new Map(),
      preloaded,
      status,
      true
    );
    if (!info) throw new Error('expected info');
    return { info, ctx: deriveReleaseDateContext(info), status };
  };

  it.each([
    ['direct', false],
    ['prefetch', true],
  ])('%s: no season countdown, season started 2 days ago', async (_n, pre) => {
    const { info, ctx, status } = await run(pre);
    expect(status.failed).toBe(false);
    expect(info.nextEpisodeAirDate).toBe(E2);
    expect(ctx.daysUntilNextSeason).toBeUndefined();
    expect(ctx.daysAgoNextSeason).toBe(2);
  });

  it.each([
    ['direct', false],
    ['prefetch', true],
  ])('%s, E1 only: no countdown at all', async (_n, pre) => {
    instances.hd.episodes = [s3(), rawEarly()];
    const { ctx } = await run(pre);
    expect(ctx.daysUntilNextSeason).toBeUndefined();
    expect(ctx.daysUntilNextEpisode).toBeUndefined();
    expect(ctx.nextSeasonAirDate).toBeUndefined();
    expect(ctx.daysAgoNextSeason).toBe(2);
  });

  it('E1 only with a later TMDB season date: fallback skips the arrived season', async () => {
    instances.hd.episodes = [s3(), rawEarly()];
    mockGetTvShow.mockResolvedValue({
      ...TMDB_SHOW(),
      seasons: [
        { season_number: 3, air_date: '2025-02-16' },
        { season_number: 4, air_date: '2026-11-23' },
      ],
    });
    const { ctx } = await run();
    expect(ctx.daysUntilNextSeason).toBeUndefined();
    expect(ctx.nextSeasonAirDate).toBeUndefined();
  });
});

describe('two Sonarr instances', () => {
  const hdOnly = () => [s3(), { ...rawEarly(), hasFile: false }, e2()];
  const uhd = () => [
    s3(),
    { ...rawEarly(), episodeFileId: 601 },
    { ...e2(), hasFile: false },
  ];

  beforeEach(() => {
    setHosts(TWO_HOSTS);
    instances = {
      hd: { series: [SERIES()], episodes: hdOnly() },
      uhd: {
        series: [SERIES()],
        episodes: uhd(),
        files: { 601: { dateAdded: ADDED } },
      },
    };
  });

  it('a file on either instance counts as arrived, in either order', async () => {
    for (const hosts of [TWO_HOSTS, [...TWO_HOSTS].reverse()]) {
      setHosts(hosts);
      expect(await fetchNextEpisodeFromSonarr(399731)).toMatchObject({
        kind: 'found',
        episode: { nextEpisodeAirDate: E2, episodeNumber: 2 },
      });
    }
  });

  it('the summary uses the earliest effective date across instances', async () => {
    const ctx = await fetchSonarrEpisodeContext(1, 399731);
    expect(ctx.lastAiredEpisodeNumber).toBe(1);
    expect(ctx.lastAiredEpisodeDate).toBe(ADDED);
  });

  it('merge keeps the earliest date and the scheduled instant', () => {
    const [row] = mergeSonarrEpisodes<SonarrEpisodeRow>([
      [{ ...rawEarly(), airDateUtc: PREMIERE }],
      withEffectiveAirDates([early()]),
    ]);
    expect(row.airDateUtc).toBe(ADDED);
    expect(row.scheduledAirDateUtc).toBe(PREMIERE);
  });

  it('without an early arrival the first instance date wins', () => {
    const a = { ...s3(), airDateUtc: '2025-04-14T01:00:00Z' };
    const b = { ...s3(), airDateUtc: '2025-04-13T01:00:00Z' };
    expect(
      mergeSonarrEpisodes<SonarrEpisodeRow>([[a], [b]])[0].airDateUtc
    ).toBe(a.airDateUtc);
    expect(
      mergeSonarrEpisodes<SonarrEpisodeRow>([[b], [a]])[0].airDateUtc
    ).toBe(b.airDateUtc);
  });

  it('an early copy overrides a later-dated normal copy only', () => {
    const early1 = withEffectiveAirDates([early()]);
    const normal = [{ ...rawEarly(), hasFile: false }];
    expect(
      mergeSonarrEpisodes<SonarrEpisodeRow>([normal, early1])[0].airDateUtc
    ).toBe(ADDED);
    expect(
      mergeSonarrEpisodes<SonarrEpisodeRow>([early1, normal])[0].airDateUtc
    ).toBe(ADDED);
  });

  it('two early copies: the premiere date is the earliest import', async () => {
    const LATER = '2026-11-21T10:00:00Z';
    instances.hd.files = { 501: { dateAdded: LATER } };
    instances.hd.episodes = [s3(), rawEarly(), e2()];
    instances.uhd.files = { 601: { dateAdded: ADDED } };
    for (const hosts of [TWO_HOSTS, [...TWO_HOSTS].reverse()]) {
      setHosts(hosts);
      const info = await fetchReleaseDateInfo(
        1,
        'show',
        new Map(),
        undefined,
        { failed: false },
        true
      );
      expect(info?.lastSeasonAirDate).toBe(ADDED);
    }
  });

  it('a failed instance with no found is still failed', async () => {
    instances.hd.failSeries = true;
    instances.uhd.episodes = [s3(), rawEarly()];
    instances.uhd.files = { 501: { dateAdded: ADDED } };
    expect((await fetchNextEpisodeFromSonarr(399731)).kind).toBe('failed');
  });
});

describe('after the scheduled air time passes', () => {
  const afterAirtime = () => {
    vi.setSystemTime(new Date('2026-11-23T03:00:00Z'));
    instances.hd.series = [{ ...SERIES(), nextAiring: E2 }];
  };

  it('keeps the early date, so the premiere is not airing today', async () => {
    afterAirtime();
    const ctx = await fetchSonarrEpisodeContext(1, 399731);
    expect(ctx.episodesAiringToday).toBe(0);
    expect(ctx.lastAiredSeasonNumber).toBe(4);
    expect(ctx.lastAiredEpisodeNumber).toBe(1);
    expect(ctx.lastAiredEpisodeDate).toBe(ADDED);
  });

  it('still looks up the file for an episode aired within 14 days', async () => {
    afterAirtime();
    await fetchSonarrEpisodeContext(1, 399731);
    expect(mockGetEpisodeFile).toHaveBeenCalledWith('hd', 501);
  });

  it('skips the file lookup for episodes aired more than 14 days ago', async () => {
    afterAirtime();
    await fetchSonarrEpisodeContext(1, 399731);
    expect(mockGetEpisodeFile).not.toHaveBeenCalledWith('hd', 301);
  });

  it('an old episode imported long after airing keeps its air date', () => {
    const row = {
      ...s3(),
      episodeFile: { dateAdded: '2026-11-22T00:00:00Z' },
    };
    expect(effectiveAirDateUtc(row)).toBe(s3().airDateUtc);
  });
});

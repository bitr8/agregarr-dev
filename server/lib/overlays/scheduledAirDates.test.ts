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
  failSeries?: boolean;
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
      return { dateAdded: '2026-11-22T00:00:00Z' };
    }
  },
}));

import {
  fetchNextEpisodeFromSonarr,
  fetchReleaseDateInfo,
  fetchSonarrEpisodeContext,
  resolveSonarrFirstNextEpisode,
} from './OverlayContextBuilder';
import { deriveReleaseDateContext } from './releaseDateContext';
import {
  mergeSonarrEpisodes,
  summariseSonarrEpisodes,
  type SonarrEpisodeRow,
} from './sonarrEpisodeSummary';

const PREMIERE = '2026-11-23T02:00:00Z';
const E2 = '2026-11-30T02:00:00Z';
const ONE_HOST = [{ hostname: 'hd', port: 8989, useSsl: false, apiKey: 'k' }];
const TWO_HOSTS = [
  ...ONE_HOST,
  { hostname: 'uhd', port: 8989, useSsl: false, apiKey: 'k' },
];

const s3 = () => ({
  seasonNumber: 3,
  episodeNumber: 10,
  airDateUtc: '2025-04-14T01:00:00Z',
  hasFile: true,
  episodeFileId: 301,
});
const e1 = (hasFile = true) => ({
  seasonNumber: 4,
  episodeNumber: 1,
  airDateUtc: PREMIERE,
  hasFile,
  episodeFileId: hasFile ? 501 : 0,
});
const e2 = () => ({
  seasonNumber: 4,
  episodeNumber: 2,
  airDateUtc: E2,
  hasFile: false,
});
const SERIES = () => ({ id: 66, tvdbId: 399731, nextAiring: PREMIERE });

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
  vi.setSystemTime(new Date('2026-11-22T12:45:00Z')); // 23:45 AEDT
  setHosts(ONE_HOST);
  instances = {
    hd: { series: [SERIES()], episodes: [s3(), e1(), e2()] },
  };
  mockGetTvShow.mockResolvedValue(TMDB_SHOW());
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('a file that arrived early does not move any date', () => {
  it('the next episode and season stay on the scheduled premiere', async () => {
    expect(await fetchNextEpisodeFromSonarr(399731)).toMatchObject({
      kind: 'found',
      episode: {
        nextEpisodeAirDate: PREMIERE,
        nextSeasonAirDate: PREMIERE,
        seasonNumber: 4,
        episodeNumber: 1,
      },
    });
  });

  it('an early file is not looked up, the premiere is not last aired', async () => {
    const ctx = await fetchSonarrEpisodeContext(1, 399731);
    expect(mockGetEpisodeFile).not.toHaveBeenCalled();
    expect(ctx.lastAiredSeasonNumber).toBe(3);
    expect(ctx.lastAiredEpisodeNumber).toBe(10);
    expect(ctx.nextEpisodeCount).toBe(1);
  });

  it('only the early premiere left: the countdown stays, with no file call', async () => {
    instances.hd.episodes = [s3(), e1()];
    expect(await fetchNextEpisodeFromSonarr(399731)).toMatchObject({
      kind: 'found',
      episode: { nextEpisodeAirDate: PREMIERE, nextSeasonAirDate: PREMIERE },
    });
    expect(mockGetEpisodeFile).not.toHaveBeenCalled();
  });

  it.each([
    ['direct', false],
    ['prefetch', true],
  ])(
    '%s: days until the season stays 1 on 22/11, whatever is on disk',
    async (_n, pre) => {
      const preloaded = pre
        ? new Map([
            [
              '1:show',
              {
                releaseDate: '2021-11-14',
                nextEpisodeAirDate: '2026-11-22',
                nextSeasonAirDate: '2026-11-22',
                seasonNumber: 4,
                episodeNumber: 1,
                tvdbId: 399731,
              },
            ],
          ])
        : undefined;
      const status = { failed: false };
      const info = await fetchReleaseDateInfo(
        1,
        'show',
        new Map(),
        preloaded,
        status,
        true
      );
      if (!info) throw new Error('expected info');
      const ctx = deriveReleaseDateContext(info);
      expect(status.failed).toBe(false);
      expect(ctx.daysUntilNextSeason).toBe(1);
      expect(ctx.daysUntilNextEpisode).toBe(1);
      expect(ctx.daysAgoNextSeason).toBeUndefined();
      expect(mockGetEpisodeFile).not.toHaveBeenCalled();
    }
  );

  it('TMDB countdown is kept when Sonarr has nothing upcoming', () => {
    const base = {
      releaseDate: '2021-11-14',
      nextEpisodeAirDate: '2026-11-22',
      nextSeasonAirDate: '2026-11-22',
      seasonNumber: 4,
      episodeNumber: 1,
    };
    expect(resolveSonarrFirstNextEpisode(base, { kind: 'none' }).info).toEqual(
      base
    );
  });

  it('fetchReleaseDateInfo with the next-episode lookup off makes no Sonarr episode calls', async () => {
    const info = await fetchReleaseDateInfo(
      1,
      'show',
      new Map(),
      undefined,
      { failed: false },
      false,
      false
    );
    expect(info?.nextEpisodeAirDate).toBe('2026-11-22');
    expect(mockGetEpisodesCall).not.toHaveBeenCalled();
    expect(mockGetEpisodeFile).not.toHaveBeenCalled();
  });
});

describe('Blue Planet III, E04 to E06 imported on 22/11', () => {
  const blue = (n: number, airDateUtc: string, finaleType?: string) => ({
    seasonNumber: 1,
    episodeNumber: n,
    airDateUtc,
    finaleType: finaleType ?? null,
    hasFile: true,
    episodeFileId: 700 + n,
  });
  const episodes = () => [
    blue(1, '2026-11-01T00:30:00Z'),
    blue(2, '2026-11-08T00:30:00Z'),
    blue(3, '2026-11-15T00:30:00Z'),
    blue(4, '2026-11-22T00:30:00Z'),
    blue(5, '2026-11-29T00:30:00Z'),
    blue(6, '2026-12-06T00:30:00Z', 'series'),
  ];

  beforeEach(() => {
    instances = {
      hd: {
        series: [{ id: 70, tvdbId: 5, nextAiring: '2026-11-29T00:30:00Z' }],
        episodes: episodes(),
      },
    };
  });

  it('22/11: one episode airs today and the series finale is 06/12', async () => {
    vi.setSystemTime(new Date('2026-11-22T02:00:00Z'));
    const ctx = await fetchSonarrEpisodeContext(1, 5);
    expect(ctx.episodesAiringToday).toBe(1);
    expect(ctx.todayEpisodeNumber).toBe(4);
    expect(ctx.nextFinaleType).toBe('series');
    expect(ctx.nextFinaleDate).toBe('2026-12-06T00:30:00Z');
    expect(ctx.daysUntilNextFinale).toBe(14);
    expect(ctx.nextEpisodeCount).toBe(1);
    expect(mockGetEpisodeFile).not.toHaveBeenCalled();
  });

  it('29/11: episode 5 airs today even though it has been on disk for a week', async () => {
    vi.setSystemTime(new Date('2026-11-29T02:00:00Z'));
    const ctx = await fetchSonarrEpisodeContext(1, 5);
    expect(ctx.episodesAiringToday).toBe(1);
    expect(ctx.todaySeasonNumber).toBe(1);
    expect(ctx.todayEpisodeNumber).toBe(5);
    expect(ctx.daysUntilNextFinale).toBe(7);
  });

  it('06/12: the finale airs today', async () => {
    vi.setSystemTime(new Date('2026-12-06T02:00:00Z'));
    const ctx = await fetchSonarrEpisodeContext(1, 5);
    expect(ctx.todayEpisodeNumber).toBe(6);
    expect(ctx.daysUntilNextFinale).toBe(0);
  });
});

describe('airing today holds for the whole local day', () => {
  const rows: SonarrEpisodeRow[] = [
    { seasonNumber: 2, episodeNumber: 5, airDateUtc: '2026-11-22T09:00:00Z' },
    { seasonNumber: 2, episodeNumber: 6, airDateUtc: '2026-11-29T09:00:00Z' },
  ];

  it('is still today at 23:59 and clears at 00:01', () => {
    vi.setSystemTime(new Date('2026-11-22T12:59:00Z')); // 23:59 AEDT
    expect(summariseSonarrEpisodes(rows).episodesAiringToday).toBe(1);
    vi.setSystemTime(new Date('2026-11-22T13:01:00Z')); // 00:01 AEDT 23/11
    const after = summariseSonarrEpisodes(rows);
    expect(after.episodesAiringToday).toBe(0);
    expect(after.lastAiredEpisodeNumber).toBe(5);
  });
});

describe('downloaded flags', () => {
  it('next episode and next season follow the file on the upcoming premiere', () => {
    const s = summariseSonarrEpisodes([s3(), e1(), e2()]);
    expect(s.nextEpisodeDownloaded).toBe(true);
    expect(s.nextSeasonDownloaded).toBe(true);
    const none = summariseSonarrEpisodes([s3(), e1(false), e2()]);
    expect(none.nextEpisodeDownloaded).toBe(false);
    expect(none.nextSeasonDownloaded).toBe(false);
  });

  it('the season flag is undefined when the next episode is mid-season', () => {
    const s = summariseSonarrEpisodes([
      { ...e1(), airDateUtc: '2026-11-01T02:00:00Z' },
      { ...e2(), hasFile: true },
    ]);
    expect(s.nextEpisodeDownloaded).toBe(true);
    expect(s.nextSeasonDownloaded).toBeUndefined();
  });

  it('both are undefined with nothing upcoming', () => {
    const s = summariseSonarrEpisodes([s3()]);
    expect(s.nextEpisodeDownloaded).toBeUndefined();
    expect(s.nextSeasonDownloaded).toBeUndefined();
  });

  it('both are undefined for a show Sonarr does not track', async () => {
    instances.hd.series = [];
    const ctx = await fetchSonarrEpisodeContext(1, 399731);
    expect(ctx).toEqual({});
  });
});

describe('two Sonarr instances', () => {
  beforeEach(() => {
    setHosts(TWO_HOSTS);
    instances = {
      hd: { series: [SERIES()], episodes: [s3(), e1(false), e2()] },
      uhd: { series: [SERIES()], episodes: [s3(), e1(true), e2()] },
    };
  });

  it('a file on either instance counts, in either order', async () => {
    for (const hosts of [TWO_HOSTS, [...TWO_HOSTS].reverse()]) {
      setHosts(hosts);
      const ctx = await fetchSonarrEpisodeContext(1, 399731);
      expect(ctx.nextSeasonDownloaded).toBe(true);
      expect(ctx.nextEpisodeDownloaded).toBe(true);
    }
  });

  it('the scheduled premiere is unchanged by the copy that has a file', async () => {
    expect(await fetchNextEpisodeFromSonarr(399731)).toMatchObject({
      kind: 'found',
      episode: { nextEpisodeAirDate: PREMIERE, episodeNumber: 1 },
    });
    expect(mockGetEpisodeFile).not.toHaveBeenCalled();
  });

  it('merge keeps the first instance date and ORs hasFile', () => {
    const a = { ...s3(), airDateUtc: '2025-04-14T01:00:00Z', hasFile: false };
    const b = { ...s3(), airDateUtc: '2025-04-13T01:00:00Z', hasFile: true };
    const [row] = mergeSonarrEpisodes<SonarrEpisodeRow>([[a], [b]]);
    expect(row.airDateUtc).toBe(a.airDateUtc);
    expect(row.hasFile).toBe(true);
  });

  it('a failed instance with no found is still failed', async () => {
    instances.hd.failSeries = true;
    instances.uhd.episodes = [s3()];
    instances.uhd.series = [{ ...SERIES(), nextAiring: undefined }];
    expect((await fetchNextEpisodeFromSonarr(399731)).kind).toBe('failed');
  });
});

describe('next undownloaded episode', () => {
  const DAY = 86400000;
  const row = (
    episodeNumber: number,
    inDays: number,
    extra: Partial<SonarrEpisodeRow> = {}
  ): SonarrEpisodeRow => ({
    seasonNumber: 1,
    episodeNumber,
    airDateUtc: new Date(Date.now() + inDays * DAY).toISOString(),
    hasFile: false,
    monitored: true,
    ...extra,
  });

  it('skips the next episode when it has a file: E2 in 4 days downloaded, E3 in 11 days missing', () => {
    const s = summariseSonarrEpisodes([
      row(1, -3, { hasFile: true }),
      row(2, 4, { hasFile: true }),
      row(3, 11),
    ]);
    expect(s.nextEpisodeDownloaded).toBe(true);
    expect(s.daysUntilNextUndownloadedEpisode).toBe(11);
    expect(s.nextUndownloadedSeasonNumber).toBe(1);
    expect(s.nextUndownloadedEpisodeNumber).toBe(3);
    expect(s.nextUndownloadedEpisodeDate).toBe(
      new Date(Date.now() + 11 * DAY).toISOString()
    );
  });

  it('skips an unmonitored episode', () => {
    const s = summariseSonarrEpisodes([
      row(2, 4, { hasFile: true }),
      row(3, 11, { monitored: false }),
      row(4, 18),
    ]);
    expect(s.nextUndownloadedEpisodeNumber).toBe(4);
    expect(s.daysUntilNextUndownloadedEpisode).toBe(18);
  });

  it('an undownloaded episode scheduled today is 0 all day, past its air time too', () => {
    const rows = [
      {
        ...row(5, 0),
        airDateUtc: '2026-11-22T09:00:00Z', // 20:00 AEDT
      },
      row(6, 7),
    ];
    for (const [now, days] of [
      ['2026-11-21T12:00:00Z', 1], // 23:00 AEDT the day before
      ['2026-11-21T14:00:00Z', 0], // 01:00 AEDT
      ['2026-11-22T12:59:00Z', 0], // 23:59 AEDT, after air time
    ] as const) {
      vi.setSystemTime(new Date(now));
      expect(
        summariseSonarrEpisodes(rows).daysUntilNextUndownloadedEpisode
      ).toBe(days);
    }
    vi.setSystemTime(new Date('2026-11-22T13:01:00Z'));
    expect(summariseSonarrEpisodes(rows).nextUndownloadedEpisodeNumber).toBe(6);
  });

  it('is undefined when every upcoming episode is downloaded, unmonitored, or already aired', () => {
    const s = summariseSonarrEpisodes([
      row(1, -9),
      row(2, 4, { hasFile: true }),
      row(3, 11, { monitored: false }),
      { seasonNumber: 0, episodeNumber: 1, airDateUtc: row(1, 2).airDateUtc },
      { ...row(4, 20), airDateUtc: undefined },
    ]);
    expect(s.nextUndownloadedEpisodeDate).toBeUndefined();
    expect(s.daysUntilNextUndownloadedEpisode).toBeUndefined();
    expect(s.nextUndownloadedSeasonNumber).toBeUndefined();
    expect(s.nextUndownloadedEpisodeNumber).toBeUndefined();
  });

  it('is empty for a show Sonarr does not track', async () => {
    instances.hd.series = [];
    expect(await fetchSonarrEpisodeContext(1, 399731)).toEqual({});
  });

  it('a file on the second instance counts as downloaded', async () => {
    setHosts(TWO_HOSTS);
    const pre = (extra: Partial<SonarrEpisodeRow>) => [
      { ...e1(false), monitored: true, ...extra },
      { ...e2(), monitored: true },
    ];
    instances = {
      hd: { series: [SERIES()], episodes: pre({}) },
      uhd: { series: [SERIES()], episodes: pre({ hasFile: true }) },
    };
    for (const hosts of [TWO_HOSTS, [...TWO_HOSTS].reverse()]) {
      setHosts(hosts);
      const ctx = await fetchSonarrEpisodeContext(1, 399731);
      expect(ctx.nextUndownloadedEpisodeNumber).toBe(2);
    }
  });
});

process.env.TZ = 'Europe/Copenhagen';

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

let episodes: unknown[] = [];
const mockGetEpisodeFile = vi.fn();
vi.mock('@server/api/servarr/sonarr', () => ({
  default: class {
    async getSeries() {
      return [
        {
          id: 70,
          tvdbId: 5,
          monitored: true,
          nextAiring: '2026-11-29T20:00:00Z',
        },
      ];
    }
    async getEpisodesBySeries() {
      return episodes;
    }
    async getEpisodeFile(...args: unknown[]) {
      mockGetEpisodeFile(...args);
      return { dateAdded: '2026-11-22T10:00:00Z' };
    }
  },
}));

import { fetchSonarrEpisodeContext } from './OverlayContextBuilder';

// Blue Planet III airs 21:00 Copenhagen (20:00Z); E04 to E06 were all imported on 22/11.
const blue = (n: number, airDateUtc: string, finaleType?: string) => ({
  seasonNumber: 1,
  episodeNumber: n,
  airDateUtc,
  finaleType: finaleType ?? null,
  hasFile: true,
  monitored: true,
  episodeFileId: 700 + n,
});
const rows = () => [
  blue(1, '2026-11-01T20:00:00Z'),
  blue(2, '2026-11-08T20:00:00Z'),
  blue(3, '2026-11-15T20:00:00Z'),
  blue(4, '2026-11-22T20:00:00Z'),
  blue(5, '2026-11-29T20:00:00Z'),
  blue(6, '2026-12-06T20:00:00Z', 'series'),
];

beforeEach(() => {
  vi.useFakeTimers();
  mockGetSettings.mockReturnValue({
    sonarr: [{ hostname: 'hd', port: 8989, useSsl: false, apiKey: 'k' }],
    overlays: {},
  });
  mockGetTvShow.mockResolvedValue({});
  episodes = rows();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Blue Planet III under Europe/Copenhagen', () => {
  it.each(['2026-11-22T10:00:00Z', '2026-11-22T22:30:00Z'])(
    '22/11 at %s: one episode airs today, the series finale is 06/12',
    async (now) => {
      vi.setSystemTime(new Date(now));
      const ctx = await fetchSonarrEpisodeContext(1, 5);
      expect(ctx.episodesAiringToday).toBe(1);
      expect(ctx.todayEpisodeNumber).toBe(4);
      expect(ctx.nextFinaleType).toBe('series');
      expect(ctx.nextFinaleDate).toBe('2026-12-06T20:00:00Z');
      expect(ctx.daysUntilNextFinale).toBe(14);
      expect(ctx.nextEpisodeCount).toBe(1);
      expect(mockGetEpisodeFile).not.toHaveBeenCalled();
    }
  );

  it('23/11 00:30 local: the 22/11 episode is no longer today', async () => {
    vi.setSystemTime(new Date('2026-11-22T23:30:00Z'));
    const ctx = await fetchSonarrEpisodeContext(1, 5);
    expect(ctx.episodesAiringToday).toBe(0);
    expect(ctx.lastAiredEpisodeNumber).toBe(4);
  });

  it('29/11: episode 5 airs today although it has been on disk for a week', async () => {
    vi.setSystemTime(new Date('2026-11-29T10:00:00Z'));
    const ctx = await fetchSonarrEpisodeContext(1, 5);
    expect(ctx.episodesAiringToday).toBe(1);
    expect(ctx.todayEpisodeNumber).toBe(5);
    expect(ctx.daysUntilNextFinale).toBe(7);
  });

  it('06/12: the finale airs today', async () => {
    vi.setSystemTime(new Date('2026-12-06T10:00:00Z'));
    const ctx = await fetchSonarrEpisodeContext(1, 5);
    expect(ctx.todayEpisodeNumber).toBe(6);
    expect(ctx.daysUntilNextFinale).toBe(0);
  });

  it('everything on disk: no next undownloaded episode', async () => {
    vi.setSystemTime(new Date('2026-11-22T10:00:00Z'));
    const ctx = await fetchSonarrEpisodeContext(1, 5);
    expect(ctx.nextUndownloadedEpisodeDate).toBeUndefined();
    expect(ctx.nextUndownloadedEpisodeNumber).toBeUndefined();
  });

  it('only E05 imported: the finale is the next undownloaded episode', async () => {
    vi.setSystemTime(new Date('2026-11-22T10:00:00Z'));
    episodes = rows().map((e) =>
      (e as { episodeNumber: number }).episodeNumber === 6
        ? { ...e, hasFile: false }
        : e
    );
    const ctx = await fetchSonarrEpisodeContext(1, 5);
    expect(ctx).toMatchObject({
      nextUndownloadedEpisodeDate: '2026-12-06T20:00:00Z',
      daysUntilNextUndownloadedEpisode: 14,
      nextUndownloadedSeasonNumber: 1,
      nextUndownloadedEpisodeNumber: 6,
    });
  });
});

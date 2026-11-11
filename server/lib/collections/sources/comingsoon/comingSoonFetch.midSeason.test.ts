import type { CollectionConfig } from '@server/lib/settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  episodes: [] as unknown[],
}));

vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    sonarr: [
      {
        id: 1,
        name: 'tv',
        hostname: 'sonarr.invalid',
        port: 8989,
        apiKey: 'k',
      },
    ],
    radarr: [],
  }),
}));
vi.mock('@server/api/servarr/sonarr', () => ({
  default: class {
    getSeries = async () => [
      {
        id: 10,
        title: 'Example Show',
        monitored: true,
        seriesType: 'standard',
        tvdbId: 555,
        year: 2020,
        tags: [],
      },
    ];
    getEpisodesBySeries = async () => mocks.episodes;
  },
}));
vi.mock('@server/api/servarr/radarr', () => ({ default: class {} }));
vi.mock('@server/api/trakt', () => ({ default: class {} }));
vi.mock('@server/api/themoviedb', () => ({
  default: class {
    getByExternalId = async () => ({ tv_results: [{ id: 777 }] });
  },
}));
vi.mock('@server/utils/traktAuth', () => ({
  buildTraktRedirectUri: vi.fn(),
  persistTraktTokens: vi.fn(),
}));

import { fetchMonitoredShows } from '@server/lib/collections/sources/comingsoon/comingSoonFetch';

const inDays = (n: number) =>
  new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();

const ep = (
  seasonNumber: number,
  episodeNumber: number,
  airDays: number,
  extra: Record<string, unknown> = {}
) => ({
  seasonNumber,
  episodeNumber,
  airDateUtc: inDays(airDays),
  monitored: true,
  episodeFileId: 0,
  ...extra,
});

const baseConfig = (extra: Record<string, unknown> = {}) =>
  ({ placeholderDaysAhead: 30, ...extra } as unknown as CollectionConfig);

describe('fetchMonitoredShows mid-season episodes', () => {
  beforeEach(() => {
    mocks.episodes = [];
  });

  it('excludes a mid-season next episode when the option is off', async () => {
    mocks.episodes = [ep(2, 1, -60, { episodeFileId: 9 }), ep(2, 5, 3)];
    const items = await fetchMonitoredShows(baseConfig());
    expect(items).toHaveLength(0);
  });

  it('includes a mid-season next episode when the option is on', async () => {
    mocks.episodes = [ep(2, 1, -60, { episodeFileId: 9 }), ep(2, 5, 3)];
    const items = await fetchMonitoredShows(
      baseConfig({ comingSoonIncludeMidSeason: true })
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      seasonNumber: 2,
      episodeNumber: 5,
      isReturning: true,
    });
  });

  it('lists one entry per show, using the earliest upcoming episode', async () => {
    mocks.episodes = [ep(2, 7, 20), ep(2, 5, 3), ep(2, 6, 10)];
    const items = await fetchMonitoredShows(
      baseConfig({ comingSoonIncludeMidSeason: true })
    );
    expect(items).toHaveLength(1);
    expect(items[0].episodeNumber).toBe(5);
  });

  it('picks the earliest premiere when seasons arrive out of order', async () => {
    mocks.episodes = [ep(4, 1, 25), ep(3, 1, 5)];
    const items = await fetchMonitoredShows(baseConfig());
    expect(items).toHaveLength(1);
    expect(items[0].seasonNumber).toBe(3);
  });

  it('still includes premieres with the option off, unchanged', async () => {
    mocks.episodes = [ep(1, 1, 4), ep(1, 2, 11)];
    const items = await fetchMonitoredShows(baseConfig());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      seasonNumber: 1,
      episodeNumber: 1,
      isReturning: false,
    });
  });
});

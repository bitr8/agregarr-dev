process.env.TZ = 'Australia/Sydney';

import type { ComingSoonSourceData } from '@server/lib/collections/core/types';
import { describe, expect, it, vi } from 'vitest';

const DROP = '2026-11-25T02:00:00Z';

vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    sonarr: [{ id: 1, hostname: 'sonarr.invalid', port: 8989, apiKey: 'k' }],
    radarr: [],
  }),
}));
vi.mock('@server/api/servarr/sonarr', () => ({
  default: class {
    getSeries = async () => [{ id: 1099, tvdbId: 424855, monitored: true }];
    getEpisodesBySeries = async () => [
      {
        seasonNumber: 1,
        episodeNumber: 1,
        airDateUtc: DROP,
        monitored: true,
        episodeFileId: 0,
      },
    ];
  },
}));
vi.mock('@server/api/servarr/radarr', () => ({ default: class {} }));
vi.mock('@server/api/trakt', () => ({ default: class {} }));
vi.mock('@server/api/themoviedb', () => ({ default: class {} }));
vi.mock('@server/utils/traktAuth', () => ({
  buildTraktRedirectUri: vi.fn(),
  persistTraktTokens: vi.fn(),
}));

import { markMonitoredStatus } from '@server/lib/collections/sources/comingsoon/comingSoonFetch';

const show = (airDate: string, seasonNumber = 1) =>
  ({
    tmdbId: 171802,
    tvdbId: 424855,
    mediaType: 'tv',
    title: 'Blade Runner 2099',
    airDate,
    seasonNumber,
  } as unknown as ComingSoonSourceData);

describe('markMonitoredStatus premiere date', () => {
  it("replaces TMDB's US day with Sonarr's S01E01 instant", async () => {
    const item = show('2026-11-24');
    await markMonitoredStatus([item], 3650, 3650);
    expect(item.airDate).toBe(DROP);
  });

  it('keeps a returning season date', async () => {
    const item = show('2026-12-01', 2);
    await markMonitoredStatus([item], 3650, 3650);
    expect(item.airDate).toBe('2026-12-01');
  });
});

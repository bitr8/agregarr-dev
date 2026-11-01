import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const mockGetMovies = vi.fn();
vi.mock('@server/api/servarr/radarr', () => ({
  default: class {
    getMovies = mockGetMovies;
  },
}));

vi.mock('@server/api/themoviedb', () => ({
  default: class {
    getTvShow = () => Promise.resolve({ external_ids: { tvdb_id: 999 } });
  },
}));

const NOW = new Date('2026-09-17T00:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

import {
  calculateMissingEpisodeCount,
  checkMonitoringStatus,
  daysSince,
} from './OverlayContextBuilder';

describe('calculateMissingEpisodeCount', () => {
  it('is 0 for the unmonitored-after-delete case (episodeCount tracks episodeFileCount)', () => {
    expect(
      calculateMissingEpisodeCount([
        {
          seasonNumber: 1,
          monitored: true,
          statistics: {
            episodeFileCount: 0,
            episodeCount: 0,
            totalEpisodeCount: 18,
            sizeOnDisk: 0,
            percentOfEpisodes: 0,
          },
        },
      ])
    ).toBe(0);
  });

  it('sums monitored-aired episodes missing a file', () => {
    expect(
      calculateMissingEpisodeCount([
        {
          seasonNumber: 1,
          monitored: true,
          statistics: {
            episodeFileCount: 2,
            episodeCount: 5,
            totalEpisodeCount: 18,
            sizeOnDisk: 0,
            percentOfEpisodes: 0,
          },
        },
      ])
    ).toBe(3);
  });

  it('excludes specials (season 0)', () => {
    expect(
      calculateMissingEpisodeCount([
        {
          seasonNumber: 0,
          monitored: true,
          statistics: {
            episodeFileCount: 0,
            episodeCount: 5,
            totalEpisodeCount: 5,
            sizeOnDisk: 0,
            percentOfEpisodes: 0,
          },
        },
      ])
    ).toBe(0);
  });

  it('is 0 when seasons are absent', () => {
    expect(calculateMissingEpisodeCount(undefined)).toBe(0);
  });
});

describe('daysSince', () => {
  it('returns days elapsed since a unix-seconds timestamp', () => {
    const threeDaysAgo = NOW.getTime() / 1000 - 3 * 24 * 60 * 60;
    expect(daysSince(threeDaysAgo)).toBe(3);
  });

  it('returns undefined when the timestamp is absent', () => {
    expect(daysSince(undefined)).toBeUndefined();
  });
});

describe('checkMonitoringStatus', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('carries missingEpisodeCount through for a Sonarr series', async () => {
    mockGetSettings.mockReturnValue({
      sonarr: [{ hostname: 'h', port: 8989, useSsl: false, apiKey: 'k' }],
    });
    mockGetSeries.mockResolvedValueOnce([
      {
        tvdbId: 999,
        monitored: true,
        tags: [],
        seasons: [
          {
            seasonNumber: 1,
            monitored: true,
            statistics: {
              episodeCount: 0,
              episodeFileCount: 0,
              totalEpisodeCount: 18,
            },
          },
        ],
      },
    ]);

    const result = await checkMonitoringStatus(1, 'show');

    expect(result.missingEpisodeCount).toBe(0);
    expect(result.isMonitored).toBe(true);
  });

  it('returns the Radarr digital and physical dates for a movie', async () => {
    mockGetSettings.mockReturnValue({
      radarr: [{ hostname: 'h', port: 7878, useSsl: false, apiKey: 'k' }],
    });
    mockGetMovies.mockResolvedValueOnce([
      {
        tmdbId: 42,
        monitored: true,
        hasFile: false,
        tags: [],
        digitalRelease: '2026-11-11T00:00:00Z',
        physicalRelease: '2026-11-25T00:00:00Z',
      },
    ]);

    const result = await checkMonitoringStatus(42, 'movie');

    expect(result.inRadarr).toBe(true);
    expect(result.radarrDigitalRelease).toBe('2026-11-11T00:00:00Z');
    expect(result.radarrPhysicalRelease).toBe('2026-11-25T00:00:00Z');
  });
});

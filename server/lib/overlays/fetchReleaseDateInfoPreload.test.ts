/**
 * Regression tests for the preload branch of fetchReleaseDateInfo (fork#35).
 *
 * That branch runs BEFORE the function's main try/catch, so an unexpected throw
 * in the Sonarr-first application (as the Intl.DateTimeFormat SSR-polyfill
 * regression caused for every Sonarr datetime) would escape uncaught, bypassing
 * the Mechanism-2 skip-guard. The branch now wraps the work in its own
 * try/catch. These tests prove that guard: a throw is converted to
 * `undefined` + `fetchStatus.failed`, and the success path is unchanged.
 *
 * TZ pinned to Sydney (the "upcoming vs passed" classification is tz-sensitive).
 */
process.env.TZ = 'Australia/Sydney';

import type * as DateHelpersModule from '@server/utils/dateHelpers';
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

// Control toServerCalendarDate so we can force the fork#35-class throw the new
// preload try/catch exists to absorb, without disturbing the other date helpers
// (isAirDateUpcoming, calculateDaysSince, ...) which the path also relies on.
// vi.hoisted: the mock fn must exist when the (hoisted) factory runs at import.
const { mockToServerCalendarDate } = vi.hoisted(() => ({
  mockToServerCalendarDate: vi.fn(),
}));
vi.mock('@server/utils/dateHelpers', async (importOriginal) => {
  const actual = await importOriginal<typeof DateHelpersModule>();
  // Default: real behaviour; a test overrides with mockImplementationOnce.
  mockToServerCalendarDate.mockImplementation(actual.toServerCalendarDate);
  return {
    ...actual,
    toServerCalendarDate: (airDate: string) =>
      mockToServerCalendarDate(airDate),
  };
});

import { fetchReleaseDateInfo } from './OverlayContextBuilder';

const NOW = new Date('2026-07-11T00:00:00.000Z'); // 11/07 11:00 AEST

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('fetchReleaseDateInfo preload branch: Sonarr-first throw is contained (fork#35 Mechanism 2)', () => {
  const instance = { hostname: 'a', port: 8989, useSsl: false, apiKey: 'k' };
  // Preloaded (TMDB-derived) record carrying a bare next-episode date and a
  // tvdbId so the branch routes through applySonarrFirstNextEpisode.
  const preloadedShow = {
    releaseDate: '2020-01-01',
    nextEpisodeAirDate: '2026-07-18',
    seasonNumber: 5,
    episodeNumber: 1,
    tvdbId: 123,
  };
  // Sonarr has an upcoming episode (a datetime), so Sonarr-first engages and the
  // disagreement-logging block that calls toServerCalendarDate is reached.
  const seriesUpcoming = {
    tvdbId: 123,
    nextAiring: '2026-07-20T09:00:00Z',
    seasons: [
      {
        monitored: true,
        seasonNumber: 2,
        statistics: {
          nextAiring: '2026-07-20T09:00:00Z',
          episodeFileCount: 3,
          totalEpisodeCount: 10,
        },
      },
    ],
  };
  const preloadedMap = () =>
    new Map<string, typeof preloadedShow | null>([['555:show', preloadedShow]]);

  it('a throw inside applySonarrFirstNextEpisode -> undefined + fetchStatus.failed (not rethrown)', async () => {
    mockGetSettings.mockReturnValue({ sonarr: [instance] });
    mockGetSeries.mockResolvedValue([seriesUpcoming]);
    // Simulate the class of runtime failure (e.g. the Intl.DateTimeFormat
    // polyfill) the preload branch's try/catch exists to absorb. First call is
    // the tmdbDay conversion in the disagreement block.
    mockToServerCalendarDate.mockImplementationOnce(() => {
      throw new RangeError('timeZone is not supported.');
    });

    const fetchStatus = { failed: false };
    const result = await fetchReleaseDateInfo(
      555,
      'show',
      undefined,
      preloadedMap(),
      fetchStatus
    );

    expect(result).toBeUndefined();
    expect(fetchStatus.failed).toBe(true);
  });

  it('success path unchanged: preloaded record resolves via Sonarr-first, no failure flag', async () => {
    mockGetSettings.mockReturnValue({ sonarr: [instance] });
    mockGetSeries.mockResolvedValue([seriesUpcoming]);

    const fetchStatus = { failed: false };
    const result = await fetchReleaseDateInfo(
      555,
      'show',
      undefined,
      preloadedMap(),
      fetchStatus
    );

    expect(fetchStatus.failed).toBe(false);
    // Sonarr's upcoming datetime wins over the preloaded TMDB bare date.
    expect(result?.nextEpisodeAirDate).toBe('2026-07-20T09:00:00Z');
    expect(result?.seasonNumber).toBe(2);
  });

  it('authoritative null preload short-circuits to undefined without touching Sonarr', async () => {
    const nullMap = new Map<string, typeof preloadedShow | null>([
      ['555:show', null],
    ]);
    const fetchStatus = { failed: false };
    const result = await fetchReleaseDateInfo(
      555,
      'show',
      undefined,
      nullMap,
      fetchStatus
    );
    expect(result).toBeUndefined();
    // A cached authoritative-empty is NOT a failure - the guard must not flip it.
    expect(fetchStatus.failed).toBe(false);
    expect(mockGetSeries).not.toHaveBeenCalled();
  });
});

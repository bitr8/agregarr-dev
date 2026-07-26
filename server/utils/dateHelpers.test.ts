/**
 * Tests for dateHelpers timezone-aware date calculations.
 *
 * Reproduces the off-by-one debug scenario:
 * TMDB date "2026-02-10", server TZ=Australia/Sydney (AEDT, UTC+11),
 * overlay run at various UTC times on Feb 10.
 *
 * The timezone is pinned below rather than left to the caller's environment.
 * These assertions are Sydney-specific, so an unset TZ made the suite fail or
 * pass depending on how it was invoked. `getServerTimezone()` reads
 * `process.env.TZ` at call time, and assigning it updates Node's local zone too,
 * so setting it here covers both halves of `getCalendarDateInTimezone`.
 */
process.env.TZ = 'Australia/Sydney';

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  calculateDaysSince,
  determineReleaseDate,
  extractReleaseDates,
  getToday,
  isAirDateUpcoming,
  toServerCalendarDate,
} from './dateHelpers';

describe('dateHelpers with TZ=Australia/Sydney', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('calculateDaysSince', () => {
    it('returns 0 for same-day release at 10:54 UTC (21:54 AEDT)', () => {
      // The actual overlay run time
      vi.setSystemTime(new Date('2026-02-10T10:54:00.000Z'));
      expect(calculateDaysSince('2026-02-10')).toBe(0);
    });

    it('returns 0 for same-day release at 00:00 UTC (11:00 AEDT)', () => {
      vi.setSystemTime(new Date('2026-02-10T00:00:00.000Z'));
      expect(calculateDaysSince('2026-02-10')).toBe(0);
    });

    it('returns 0 for same-day release at 12:59 UTC (23:59 AEDT)', () => {
      vi.setSystemTime(new Date('2026-02-10T12:59:00.000Z'));
      expect(calculateDaysSince('2026-02-10')).toBe(0);
    });

    it('returns 1 after AEDT midnight (13:00 UTC = Feb 11 00:00 AEDT)', () => {
      vi.setSystemTime(new Date('2026-02-10T13:00:00.000Z'));
      expect(calculateDaysSince('2026-02-10')).toBe(1);
    });

    it('returns 1 for yesterday release', () => {
      vi.setSystemTime(new Date('2026-02-10T10:54:00.000Z'));
      expect(calculateDaysSince('2026-02-09')).toBe(1);
    });

    it('returns -1 for tomorrow release', () => {
      vi.setSystemTime(new Date('2026-02-10T10:54:00.000Z'));
      expect(calculateDaysSince('2026-02-11')).toBe(-1);
    });

    it('handles "2026-02-09" input — should be 1 day ago on Feb 10 AEDT', () => {
      // If cache held "2026-02-09" instead of "2026-02-10", this is what we'd see
      vi.setSystemTime(new Date('2026-02-10T10:54:00.000Z'));
      expect(calculateDaysSince('2026-02-09')).toBe(1);
    });

    it('strips time component from ISO datetime strings', () => {
      vi.setSystemTime(new Date('2026-02-10T10:54:00.000Z'));
      // TMDB returns "2026-02-10T00:00:00.000Z" — time should be ignored
      expect(calculateDaysSince('2026-02-10T00:00:00.000Z')).toBe(0);
      expect(calculateDaysSince('2026-02-10T23:59:59.999Z')).toBe(0);
    });
  });

  describe('getToday', () => {
    it('returns Feb 10 when UTC is Feb 10 morning (AEDT evening)', () => {
      vi.setSystemTime(new Date('2026-02-10T10:54:00.000Z'));
      const today = getToday();
      expect(today.getDate()).toBe(10);
      expect(today.getMonth()).toBe(1); // 0-indexed
      expect(today.getFullYear()).toBe(2026);
    });

    it('returns Feb 11 when UTC crosses AEDT midnight boundary', () => {
      // 13:00 UTC = 00:00 AEDT on Feb 11
      vi.setSystemTime(new Date('2026-02-10T13:00:00.000Z'));
      const today = getToday();
      expect(today.getDate()).toBe(11);
    });
  });

  describe('DST boundary (AEDT→AEST transition)', () => {
    // First Sunday of April 2026: April 5
    // AEDT (UTC+11) → AEST (UTC+10) at 3:00 AM local (= 16:00 UTC April 4)
    it('calculateDaysSince is stable across DST transition', () => {
      // Before AEDT midnight: April 4 12:59 UTC = April 4 23:59 AEDT
      vi.setSystemTime(new Date('2026-04-04T12:59:00.000Z'));
      expect(calculateDaysSince('2026-04-04')).toBe(0);

      // After AEDT midnight: April 4 13:00 UTC = April 5 00:00 AEDT
      vi.setSystemTime(new Date('2026-04-04T13:00:00.000Z'));
      expect(calculateDaysSince('2026-04-04')).toBe(1);

      // After DST change: April 4 16:01 UTC = April 5 02:01 AEST (clocks fell back)
      vi.setSystemTime(new Date('2026-04-04T16:01:00.000Z'));
      expect(calculateDaysSince('2026-04-04')).toBe(1);
    });

    it('Math.floor handles 23h day correctly', () => {
      // On DST spring-forward day, the diff between midnight-to-midnight is 23h
      // Math.floor(23/24) = 0, which would be wrong if we relied on raw hour diff
      // But since both parseDate and getNow normalize to midnight, this shouldn't matter
      vi.setSystemTime(new Date('2026-04-05T14:00:00.000Z'));
      // April 5 14:00 UTC = April 6 00:00 AEST (new day)
      expect(calculateDaysSince('2026-04-05')).toBe(1);
    });
  });

  describe('extractReleaseDates', () => {
    it('finds earliest digital release across countries', () => {
      const result = extractReleaseDates([
        {
          iso_3166_1: 'US',
          release_dates: [
            { type: 4, release_date: '2026-02-10T00:00:00.000Z' },
          ],
        },
        {
          iso_3166_1: 'GB',
          release_dates: [
            { type: 4, release_date: '2026-02-08T00:00:00.000Z' },
          ],
        },
      ]);
      expect(result.digitalRelease).toBe('2026-02-08T00:00:00.000Z');
    });

    it('prefers the given region over a timezone-outlier territory (#534)', () => {
      // Real TMDB shape from Peaky Blinders 875828: UTC-11 Pacific territories
      // dated a day early, the rest of the world (incl. US/GB) a day later.
      const result = extractReleaseDates(
        [
          {
            iso_3166_1: 'AS', // American Samoa (UTC-11), TMDB dates it a day early
            release_dates: [
              { type: 4, release_date: '2026-03-19T00:00:00.000Z' },
            ],
          },
          {
            iso_3166_1: 'US',
            release_dates: [
              { type: 4, release_date: '2026-03-20T00:00:00.000Z' },
            ],
          },
          {
            iso_3166_1: 'GB',
            release_dates: [
              { type: 4, release_date: '2026-03-20T00:00:00.000Z' },
            ],
          },
        ],
        'US'
      );
      expect(result.digitalRelease).toBe('2026-03-20T00:00:00.000Z');
    });

    it('without a region, still returns the global earliest (back-compat)', () => {
      const result = extractReleaseDates([
        {
          iso_3166_1: 'AS',
          release_dates: [
            { type: 4, release_date: '2026-03-19T00:00:00.000Z' },
          ],
        },
        {
          iso_3166_1: 'US',
          release_dates: [
            { type: 4, release_date: '2026-03-20T00:00:00.000Z' },
          ],
        },
      ]);
      expect(result.digitalRelease).toBe('2026-03-19T00:00:00.000Z');
    });

    it('falls back to the global earliest when the region lacks that type', () => {
      // US has only a theatrical date; digital exists only elsewhere.
      const result = extractReleaseDates(
        [
          {
            iso_3166_1: 'US',
            release_dates: [
              { type: 3, release_date: '2026-01-01T00:00:00.000Z' },
            ],
          },
          {
            iso_3166_1: 'FR',
            release_dates: [
              { type: 4, release_date: '2026-02-05T00:00:00.000Z' },
            ],
          },
        ],
        'US'
      );
      expect(result.digitalRelease).toBe('2026-02-05T00:00:00.000Z'); // FR fallback
      expect(result.inCinemas).toBe('2026-01-01T00:00:00.000Z'); // US theatrical
    });

    it('matches the region case-insensitively', () => {
      const result = extractReleaseDates(
        [
          {
            iso_3166_1: 'US',
            release_dates: [
              { type: 4, release_date: '2026-03-20T00:00:00.000Z' },
            ],
          },
          {
            iso_3166_1: 'AS',
            release_dates: [
              { type: 4, release_date: '2026-03-19T00:00:00.000Z' },
            ],
          },
        ],
        'us'
      );
      expect(result.digitalRelease).toBe('2026-03-20T00:00:00.000Z');
    });
  });

  describe('determineReleaseDate', () => {
    it('strips time component from date strings', () => {
      const result = determineReleaseDate(
        '2026-02-10T00:00:00.000Z',
        undefined,
        undefined
      );
      expect(result?.releaseDate).toBe('2026-02-10');
      expect(result?.isEstimated).toBe(false);
    });

    it('picks earliest of digital and physical', () => {
      const result = determineReleaseDate(
        '2026-02-15T00:00:00.000Z',
        '2026-02-10T00:00:00.000Z',
        undefined
      );
      expect(result?.releaseDate).toBe('2026-02-10');
    });

    it('falls back to theatrical + 90 days', () => {
      const result = determineReleaseDate(
        undefined,
        undefined,
        '2026-01-01T00:00:00.000Z'
      );
      expect(result?.releaseDate).toBe('2026-04-01');
      expect(result?.isEstimated).toBe(true);
    });

    // The case above spans 01/01-01/04, entirely inside AEDT, so it cannot see
    // a DST shift. The Odyssey (AU theatrical 16/07) crosses the 04/10 start
    // and was rendering 13/10 in production instead of 14/10.
    it('keeps the +90 estimate on the right day across the DST start', () => {
      const result = determineReleaseDate(
        undefined,
        undefined,
        '2026-07-16T00:00:00.000Z'
      );
      expect(result?.releaseDate).toBe('2026-10-14');
      expect(result?.isEstimated).toBe(true);
    });

    it('does the same for a date-only theatrical value', () => {
      const result = determineReleaseDate(undefined, undefined, '2026-07-16');
      expect(result?.releaseDate).toBe('2026-10-14');
    });
  });
});

// capTtlForRecentRelease doesn't use getSettings, but the module imports it.
// Mock the settings dependency to avoid TypeORM decorator errors.
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({ main: { ratingsCacheMaxDays: 30 } }),
}));

describe('capTtlForRecentRelease', () => {
  let capTtlForRecentRelease: (
    releaseDate: string | undefined,
    baseTtl: number
  ) => number;
  const THREE_DAYS = 3 * 24 * 60 * 60;

  beforeAll(async () => {
    const mod = await import('../lib/overlays/adaptiveTtl');
    capTtlForRecentRelease = mod.capTtlForRecentRelease;
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns baseTtl when releaseDate is undefined', () => {
    expect(capTtlForRecentRelease(undefined, THREE_DAYS)).toBe(THREE_DAYS);
  });

  it('caps to 2h when release is today', () => {
    vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));
    expect(capTtlForRecentRelease('2026-02-10', THREE_DAYS)).toBe(2 * 60 * 60);
  });

  it('caps to 2h when release is 1 day ago', () => {
    vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));
    expect(capTtlForRecentRelease('2026-02-09', THREE_DAYS)).toBe(2 * 60 * 60);
  });

  it('caps to 2h when release is 3 days away', () => {
    vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));
    expect(capTtlForRecentRelease('2026-02-13', THREE_DAYS)).toBe(2 * 60 * 60);
  });

  it('caps to 4h when release is 5 days away', () => {
    vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));
    expect(capTtlForRecentRelease('2026-02-15', THREE_DAYS)).toBe(4 * 60 * 60);
  });

  it('returns baseTtl when release is 30 days ago', () => {
    vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));
    expect(capTtlForRecentRelease('2026-01-11', THREE_DAYS)).toBe(THREE_DAYS);
  });

  it('does not increase baseTtl when baseTtl is already small', () => {
    vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));
    const oneHour = 60 * 60;
    expect(capTtlForRecentRelease('2026-02-10', oneHour)).toBe(oneHour);
  });

  it('strips time component from datetime strings', () => {
    vi.setSystemTime(new Date('2026-02-10T10:00:00.000Z'));
    expect(capTtlForRecentRelease('2026-02-10T00:00:00.000Z', THREE_DAYS)).toBe(
      2 * 60 * 60
    );
  });
});

describe('toServerCalendarDate (TZ=Australia/Sydney)', () => {
  it('leaves a bare date untouched', () => {
    expect(toServerCalendarDate('2026-07-11')).toBe('2026-07-11');
  });

  it('converts a UTC datetime to its Sydney calendar date', () => {
    // 2026-07-11T15:00:00Z is 2026-07-12 01:00 AEST - the NEXT calendar day.
    expect(toServerCalendarDate('2026-07-11T15:00:00Z')).toBe('2026-07-12');
  });

  it('does not roll a same-day evening datetime forward', () => {
    // 2026-07-11T09:00:00Z is 2026-07-11 19:00 AEST - still the 11th.
    expect(toServerCalendarDate('2026-07-11T09:00:00Z')).toBe('2026-07-11');
  });

  it('feeding the converted date to calculateDaysSince fixes the boundary', () => {
    // fork#35: at 12/07 00:30 AEST, a Sonarr episode airing 12/07 01:00 AEST
    // (2026-07-11T15:00:00Z) is still 30 min in the FUTURE. Raw calculateDaysSince
    // strips to the UTC date 2026-07-11 and wrongly reports it as 1 day past;
    // via toServerCalendarDate it is correctly today (0).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T14:30:00.000Z')); // 12/07 00:30 AEST
    expect(calculateDaysSince('2026-07-11T15:00:00Z')).toBe(1); // the bug
    expect(
      calculateDaysSince(toServerCalendarDate('2026-07-11T15:00:00Z'))
    ).toBe(0); // the fix
    vi.useRealTimers();
  });

  it('returns an unparseable input unchanged', () => {
    expect(toServerCalendarDate('not-a-date')).toBe('not-a-date');
  });
});

describe('toServerCalendarDate survives the SSR Intl.DateTimeFormat polyfill (fork#35 prod regression)', () => {
  // The running server installs the andyearnshaw `intl` polyfill for SSR, which
  // replaces the global Intl.DateTimeFormat with an implementation that throws
  // "timeZone is not supported." for any named timezone. Date.prototype
  // .toLocaleString stays native. Native Node (where these tests run) has no such
  // polyfill, so an earlier Intl.DateTimeFormat('en-CA') implementation passed
  // every unit test yet threw for every Sonarr datetime in production, silently
  // disabling Sonarr-first. Simulate the polyfill so this failure is caught here.
  const RealDateTimeFormat = Intl.DateTimeFormat;
  beforeEach(() => {
    (Intl as unknown as { DateTimeFormat: unknown }).DateTimeFormat =
      function BrokenDateTimeFormat() {
        throw new RangeError('timeZone is not supported.');
      };
  });
  afterEach(() => {
    (Intl as unknown as { DateTimeFormat: unknown }).DateTimeFormat =
      RealDateTimeFormat;
    // Restore real timers here too, so a failing assertion in a fake-timer test
    // below cannot leak fake time into later suites.
    vi.useRealTimers();
  });

  it('converts a Sonarr UTC datetime without the global Intl.DateTimeFormat', () => {
    // 2026-07-11T15:00:00Z is 2026-07-12 01:00 AEST - the next calendar day.
    expect(toServerCalendarDate('2026-07-11T15:00:00Z')).toBe('2026-07-12');
  });

  it('a bare date is still returned untouched', () => {
    expect(toServerCalendarDate('2026-07-11')).toBe('2026-07-11');
  });

  it('isAirDateUpcoming(datetime) still resolves at the Sydney-midnight boundary', () => {
    // now = 12/07 00:30 AEST; a datetime airing 12/07 01:00 AEST is still ahead.
    // isAirDateUpcoming's datetime branch and its toServerCalendarDate call must
    // both survive the broken polyfill.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T14:30:00.000Z'));
    expect(isAirDateUpcoming('2026-07-11T15:00:00Z')).toBe(true);
    expect(
      calculateDaysSince(toServerCalendarDate('2026-07-11T15:00:00Z'))
    ).toBe(0);
    // real timers restored by afterEach
  });
});

describe('isAirDateUpcoming (TZ=Australia/Sydney)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('bare date: future and today are upcoming, past is not', () => {
    vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'));
    expect(isAirDateUpcoming('2026-07-18')).toBe(true);
    expect(isAirDateUpcoming('2026-07-11')).toBe(true);
    expect(isAirDateUpcoming('2026-07-04')).toBe(false);
  });

  it('datetime: compares the absolute instant, not the calendar day', () => {
    // now = 20:00 AEST (10:00 UTC); an episode that aired 19:00 AEST today
    // (09:00 UTC) is NOT upcoming, though it is the same calendar day.
    vi.setSystemTime(new Date('2026-07-11T10:00:00.000Z'));
    expect(isAirDateUpcoming('2026-07-11T09:00:00Z')).toBe(false);
    expect(isAirDateUpcoming('2026-07-11T11:00:00Z')).toBe(true);
  });

  it('datetime just after Sydney midnight is upcoming (fork#35 boundary)', () => {
    // now = 12/07 00:30 AEST; episode airs 12/07 01:00 AEST, 30 min ahead.
    vi.setSystemTime(new Date('2026-07-11T14:30:00.000Z'));
    expect(isAirDateUpcoming('2026-07-11T15:00:00Z')).toBe(true);
  });

  it('an unparseable datetime is treated as not upcoming (safe default)', () => {
    vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'));
    // NaN instant -> falls to the calendar branch -> NaN <= 0 is false, so it
    // never renders a bogus countdown.
    expect(isAirDateUpcoming('2026-13-99T00:00:00Z')).toBe(false);
  });
});

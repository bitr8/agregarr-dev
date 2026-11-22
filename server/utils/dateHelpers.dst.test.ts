import { afterEach, describe, expect, it, vi } from 'vitest';
import { calculateDaysSince } from './dateHelpers';

const originalTz = process.env.TZ;

afterEach(() => {
  vi.useRealTimers();
  process.env.TZ = originalTz;
});

const dayNumber = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};

// [timezone, now (instant), target date]
const cases: [string, string, string][] = [
  ['Australia/Sydney', '2026-11-21T01:00:00Z', '2026-10-03'],
  ['Australia/Sydney', '2026-11-21T01:00:00Z', '2026-10-04'],
  ['Australia/Sydney', '2026-10-02T20:00:00Z', '2026-10-05'],
  ['Australia/Sydney', '2026-04-10T01:00:00Z', '2026-04-04'],
  ['Australia/Sydney', '2026-04-03T20:00:00Z', '2026-04-06'],
  ['America/Los_Angeles', '2026-03-15T19:00:00Z', '2026-03-07'],
  ['America/Los_Angeles', '2026-03-07T19:00:00Z', '2026-03-09'],
  ['America/Los_Angeles', '2026-11-08T19:00:00Z', '2026-10-31'],
  ['America/Los_Angeles', '2026-10-31T19:00:00Z', '2026-11-02'],
  ['Pacific/Auckland', '2026-10-05T01:00:00Z', '2026-09-26'],
  ['Pacific/Auckland', '2026-09-25T01:00:00Z', '2026-09-28'],
  ['Pacific/Auckland', '2026-04-10T01:00:00Z', '2026-04-04'],
  ['Pacific/Auckland', '2026-04-03T01:00:00Z', '2026-04-06'],
  ['UTC', '2026-11-21T01:00:00Z', '2026-10-03'],
];

describe('calculateDaysSince across DST transitions', () => {
  for (const [tz, now, target] of cases) {
    it(`${tz}: ${target} seen from ${now}`, () => {
      process.env.TZ = tz;
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));
      const today = new Date(now).toLocaleDateString('en-CA', { timeZone: tz });
      expect(calculateDaysSince(target)).toBe(
        dayNumber(today) - dayNumber(target)
      );
    });
  }

  it('Sydney: 03/10 is 49 days before 21/11', () => {
    process.env.TZ = 'Australia/Sydney';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T01:00:00Z'));
    expect(calculateDaysSince('2026-10-03')).toBe(49);
  });

  it('keeps today = 0, yesterday = 1, tomorrow = -1 at any hour', () => {
    process.env.TZ = 'Australia/Sydney';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T12:00:00Z'));
    expect(calculateDaysSince('2026-11-21')).toBe(0);
    expect(calculateDaysSince('2026-11-20')).toBe(1);
    expect(calculateDaysSince('2026-11-22')).toBe(-1);
  });
});

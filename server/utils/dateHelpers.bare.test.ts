import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateDaysSince,
  isDateInFuture,
  isDateWithinDays,
} from './dateHelpers';

const zones: [string, string][] = [
  ['Pacific/Auckland', '2026-12-03T05:00:00Z'],
  ['Australia/Sydney', '2026-12-03T05:00:00Z'],
  ['America/Los_Angeles', '2026-12-03T20:00:00Z'],
  ['UTC', '2026-12-03T05:00:00Z'],
];

afterEach(() => vi.useRealTimers());

describe('bare-date day counts', () => {
  for (const [tz, now] of zones) {
    it(`a release dated today is 0 days since in ${tz}`, () => {
      process.env.TZ = tz;
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));
      expect(calculateDaysSince('2026-12-03')).toBe(0);
      expect(calculateDaysSince('2026-12-02')).toBe(1);
      expect(calculateDaysSince('2026-12-04')).toBe(-1);
      expect(isDateInFuture('2026-12-03')).toBe(false);
      expect(isDateInFuture('2026-12-04')).toBe(true);
      expect(isDateWithinDays('2026-12-04', 1)).toBe(true);
    });
  }

  it('a datetime keeps its date part', () => {
    process.env.TZ = 'UTC';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-04T05:00:00Z'));
    expect(calculateDaysSince('2026-12-03T15:30:00Z')).toBe(1);
  });
});

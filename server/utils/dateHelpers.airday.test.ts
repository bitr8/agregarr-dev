process.env.TZ = 'Australia/Sydney';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasBareAirDatePassed, isSameAirDay } from './dateHelpers';

afterEach(() => vi.useRealTimers());

// Blade Runner 2099: TMDB says 2026-11-24, it airs 21:00 ET = 2026-11-25T02:00Z.
describe('hasBareAirDatePassed', () => {
  it.each([
    ['2026-11-24T00:00:00Z', false], // 11:00 AEDT 24/11, the old "aired" moment
    ['2026-11-25T02:00:00Z', false], // airing now in the US
    ['2026-11-25T04:59:00Z', false],
    ['2026-11-25T05:00:00Z', true], // the US Eastern day is over
  ])('at %s: %s', (now, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    expect(hasBareAirDatePassed('2026-11-24')).toBe(expected);
  });
});

describe('isSameAirDay', () => {
  it('matches the US day to the instant a day later in Sydney', () => {
    expect(isSameAirDay('2026-11-24', '2026-11-25T02:00:00Z')).toBe(true);
  });
  it('rejects a different premiere', () => {
    expect(isSameAirDay('2026-11-24', '2026-11-28T02:00:00Z')).toBe(false);
    expect(isSameAirDay('2020-01-01', '2026-11-25T02:00:00Z')).toBe(false);
  });
});

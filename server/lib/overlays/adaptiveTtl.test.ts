import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { capTtlForUpcomingDate, getAdaptiveTtl } from './adaptiveTtl';

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

describe('capTtlForUpcomingDate', () => {
  const baseTtl = 7 * DAY; // typical adaptive TTL for a 2-10yr-old show

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns baseTtl when no upcoming date is given', () => {
    expect(capTtlForUpcomingDate(undefined, baseTtl)).toBe(baseTtl);
  });

  it('returns baseTtl for an unparseable date', () => {
    expect(capTtlForUpcomingDate('not-a-date', baseTtl)).toBe(baseTtl);
  });

  it('caps TTL to expire ~4h after a near-future air date', () => {
    // 2 days out -> 2 days + 4h buffer, well under the 7-day baseTtl
    expect(capTtlForUpcomingDate('2026-07-13T00:00:00Z', baseTtl)).toBe(
      2 * DAY + 4 * HOUR
    );
  });

  it('never exceeds baseTtl for a far-future date', () => {
    // 30 days out: cap would be huge, so baseTtl wins
    expect(capTtlForUpcomingDate('2026-08-10T00:00:00Z', baseTtl)).toBe(
      baseTtl
    );
  });

  it('caps a just-passed date to the 4-hour floor', () => {
    // aired a full day ago: cap goes negative, floor to 4h (the TMDB gateway
    // cache floor - refetching faster returns the same bytes)
    expect(capTtlForUpcomingDate('2026-07-10T00:00:00Z', baseTtl)).toBe(
      4 * HOUR
    );
  });

  it('floors a recently-aired date to 4h (buffer no longer clears the floor)', () => {
    // aired 3h ago: -3h + 4h buffer = 1h, below the 4h floor -> floors to 4h.
    // With buffer == floor == 4h, any passed date holds a flat 4h; Sonarr-first
    // supplies the next episode in the interim, so no countdown gap results.
    expect(capTtlForUpcomingDate('2026-07-10T21:00:00Z', baseTtl)).toBe(
      4 * HOUR
    );
  });

  it('never returns more than a smaller baseTtl', () => {
    const smallTtl = HOUR;
    expect(capTtlForUpcomingDate('2026-07-13T00:00:00Z', smallTtl)).toBe(
      smallTtl
    );
  });

  it('is bounded by baseTtl even for the floor case', () => {
    const tinyTtl = 10 * 60; // 10 min, smaller than the 4h floor
    expect(capTtlForUpcomingDate('2026-07-10T00:00:00Z', tinyTtl)).toBe(
      tinyTtl
    );
  });
});

describe('getAdaptiveTtl maxDays clamp', () => {
  // Archive year (age > 10) returns effectiveMaxDays * 1 day directly.
  const archiveYear = 2000;

  it('coerces a string-typed setting to a number', () => {
    // nostromo stores ratingsCacheMaxDays as the string "14" (verified live)
    expect(getAdaptiveTtl(archiveYear, '14' as unknown as number)).toBe(
      14 * DAY
    );
  });

  it('never returns a 0 TTL (node-cache treats 0 as never-expire)', () => {
    expect(getAdaptiveTtl(archiveYear, 0)).toBe(30 * DAY);
  });

  it('falls back to the default for a non-numeric setting', () => {
    expect(getAdaptiveTtl(archiveYear, 'nonsense' as unknown as number)).toBe(
      30 * DAY
    );
  });
});

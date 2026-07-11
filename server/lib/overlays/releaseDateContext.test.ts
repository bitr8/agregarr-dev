import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveReleaseDateContext } from './releaseDateContext';

describe('deriveReleaseDateContext', () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    process.env.TZ = 'UTC';
    vi.useFakeTimers();
    // Noon UTC keeps the calendar date unambiguous across server timezones.
    vi.setSystemTime(new Date('2026-07-11T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.TZ = originalTz;
  });

  it('computes daysUntilRelease for a future release date', () => {
    const ctx = deriveReleaseDateContext({ releaseDate: '2026-07-14' });
    expect(ctx.daysUntilRelease).toBe(3);
    expect(ctx.daysAgo).toBeUndefined();
  });

  it('computes daysAgo for a past release date', () => {
    const ctx = deriveReleaseDateContext({ releaseDate: '2026-07-08' });
    expect(ctx.daysAgo).toBe(3);
    expect(ctx.daysUntilRelease).toBeUndefined();
  });

  it('computes the countdown for a future next-episode date and keeps the date', () => {
    const ctx = deriveReleaseDateContext({
      nextEpisodeAirDate: '2026-07-18',
    });
    expect(ctx.daysUntilNextEpisode).toBe(7);
    expect(ctx.nextEpisodeAirDate).toBe('2026-07-18');
  });

  it('treats an episode airing today as upcoming (0 days), not cleared', () => {
    const ctx = deriveReleaseDateContext({
      nextEpisodeAirDate: '2026-07-11',
    });
    expect(ctx.daysUntilNextEpisode).toBe(0);
    expect(ctx.nextEpisodeAirDate).toBe('2026-07-11');
  });

  it('CLEARS a past next-episode date (fork#35 read-time guarantee)', () => {
    const ctx = deriveReleaseDateContext({
      nextEpisodeAirDate: '2026-07-04',
    });
    // The episode aired; the countdown is cleared entirely rather than
    // rendering "in N days" from a passed date or leaking a stale date.
    expect(ctx.daysUntilNextEpisode).toBeUndefined();
    expect(ctx.nextEpisodeAirDate).toBeUndefined();
  });

  it('computes daysUntilNextSeason for a future season premiere', () => {
    const ctx = deriveReleaseDateContext({
      nextSeasonAirDate: '2026-08-01',
    });
    expect(ctx.daysUntilNextSeason).toBe(21);
    expect(ctx.daysAgoNextSeason).toBeUndefined();
    expect(ctx.nextSeasonAirDate).toBe('2026-08-01');
  });

  it('keeps a past season date and reports daysAgoNextSeason (not cleared)', () => {
    const ctx = deriveReleaseDateContext({
      nextSeasonAirDate: '2026-07-01',
    });
    // Unlike the forward next-episode countdown, a past season premiere is
    // retained so overlays can show "N days ago".
    expect(ctx.daysAgoNextSeason).toBe(10);
    expect(ctx.daysUntilNextSeason).toBeUndefined();
    expect(ctx.nextSeasonAirDate).toBe('2026-07-01');
  });

  it('passes season and episode numbers through unchanged', () => {
    const ctx = deriveReleaseDateContext({
      nextEpisodeAirDate: '2026-07-18',
      seasonNumber: 3,
      episodeNumber: 5,
    });
    expect(ctx.seasonNumber).toBe(3);
    expect(ctx.episodeNumber).toBe(5);
  });

  it('returns all-undefined day counts for empty info', () => {
    const ctx = deriveReleaseDateContext({});
    expect(ctx.daysUntilRelease).toBeUndefined();
    expect(ctx.daysAgo).toBeUndefined();
    expect(ctx.daysUntilNextEpisode).toBeUndefined();
    expect(ctx.daysUntilNextSeason).toBeUndefined();
    expect(ctx.daysAgoNextSeason).toBeUndefined();
    expect(ctx.nextEpisodeAirDate).toBeUndefined();
  });
});

describe('deriveReleaseDateContext timezone boundary (TZ=Australia/Sydney)', () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    process.env.TZ = 'Australia/Sydney';
    vi.useFakeTimers();
    // 12/07 00:30 AEST - just past Sydney midnight.
    vi.setSystemTime(new Date('2026-07-11T14:30:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.TZ = originalTz;
  });

  it('does not clear a Sonarr datetime still future in Sydney', () => {
    // 2026-07-11T15:00:00Z = 12/07 01:00 AEST, 30 min in the future. Its UTC
    // date (2026-07-11) reads as "yesterday" in Sydney; without the tz fix the
    // read-time guard would clear it and strip the overlay before airing.
    const ctx = deriveReleaseDateContext({
      nextEpisodeAirDate: '2026-07-11T15:00:00Z',
    });
    expect(ctx.nextEpisodeAirDate).toBe('2026-07-11T15:00:00Z');
    expect(ctx.daysUntilNextEpisode).toBe(0); // airs today in Sydney
  });

  it('still clears a genuinely past Sonarr datetime', () => {
    const ctx = deriveReleaseDateContext({
      nextEpisodeAirDate: '2026-07-09T09:00:00Z',
    });
    expect(ctx.nextEpisodeAirDate).toBeUndefined();
    expect(ctx.daysUntilNextEpisode).toBeUndefined();
  });

  it('clears a datetime that already aired earlier the same Sydney day', () => {
    // now = 20:00 AEST; episode aired 19:00 AEST today. Same calendar day, but
    // the airing instant has passed, so the countdown must clear (HIGH-3).
    vi.setSystemTime(new Date('2026-07-11T10:00:00.000Z'));
    const ctx = deriveReleaseDateContext({
      nextEpisodeAirDate: '2026-07-11T09:00:00Z',
    });
    expect(ctx.nextEpisodeAirDate).toBeUndefined();
    expect(ctx.daysUntilNextEpisode).toBeUndefined();
  });

  it('flips a season premiere that aired earlier today to daysAgoNextSeason', () => {
    // Symmetric with nextEpisode: past its airing instant, "premieres today"
    // becomes "premiered today" rather than a stale forward count.
    vi.setSystemTime(new Date('2026-07-11T10:00:00.000Z'));
    const ctx = deriveReleaseDateContext({
      nextSeasonAirDate: '2026-07-11T09:00:00Z',
    });
    expect(ctx.daysUntilNextSeason).toBeUndefined();
    expect(ctx.daysAgoNextSeason).toBe(0);
  });
});

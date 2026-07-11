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

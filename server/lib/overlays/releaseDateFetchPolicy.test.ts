import { describe, expect, it } from 'vitest';

import { shouldSkipOnReleaseDateFetchFailure } from './releaseDateFetchPolicy';

describe('shouldSkipOnReleaseDateFetchFailure', () => {
  it('skips conservatively when required fields are unknown', () => {
    expect(shouldSkipOnReleaseDateFetchFailure(undefined)).toBe(true);
  });

  it('does not skip when the library needs no release-date field', () => {
    expect(shouldSkipOnReleaseDateFetchFailure(new Set())).toBe(false);
    expect(
      shouldSkipOnReleaseDateFetchFailure(
        new Set(['imdbRating', 'resolution', 'network'])
      )
    ).toBe(false);
  });

  it('skips when a next-episode field is required', () => {
    expect(
      shouldSkipOnReleaseDateFetchFailure(new Set(['daysUntilNextEpisode']))
    ).toBe(true);
    expect(
      shouldSkipOnReleaseDateFetchFailure(new Set(['nextEpisodeAirDate']))
    ).toBe(true);
  });

  it('skips when only season/episode numbers are required', () => {
    expect(shouldSkipOnReleaseDateFetchFailure(new Set(['seasonNumber']))).toBe(
      true
    );
    expect(
      shouldSkipOnReleaseDateFetchFailure(new Set(['episodeNumber']))
    ).toBe(true);
  });

  it('skips when a next-season field is required', () => {
    expect(
      shouldSkipOnReleaseDateFetchFailure(new Set(['daysUntilNextSeason']))
    ).toBe(true);
    expect(
      shouldSkipOnReleaseDateFetchFailure(new Set(['daysAgoNextSeason']))
    ).toBe(true);
  });

  it('skips when a movie/general release-date field is required', () => {
    expect(
      shouldSkipOnReleaseDateFetchFailure(new Set(['daysUntilRelease']))
    ).toBe(true);
    expect(shouldSkipOnReleaseDateFetchFailure(new Set(['daysAgo']))).toBe(
      true
    );
    expect(shouldSkipOnReleaseDateFetchFailure(new Set(['releaseDate']))).toBe(
      true
    );
  });

  it('skips when a needed date field sits alongside unrelated fields', () => {
    expect(
      shouldSkipOnReleaseDateFetchFailure(
        new Set(['imdbRating', 'resolution', 'daysUntilNextEpisode'])
      )
    ).toBe(true);
  });
});

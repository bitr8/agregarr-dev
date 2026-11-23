import { describe, expect, it } from 'vitest';

import {
  needsSonarrEpisodeList,
  shouldSkipOnReleaseDateFetchFailure,
  usesSonarrEpisodeSummary,
  usesSonarrNextEpisode,
} from './releaseDateFetchPolicy';

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

describe('usesSonarrNextEpisode', () => {
  it('is on when the fields are unknown', () => {
    expect(usesSonarrNextEpisode(undefined)).toBe(true);
  });

  it('is off for a library that reads no schedule field', () => {
    expect(usesSonarrNextEpisode(new Set(['imdbRating', 'resolution']))).toBe(
      false
    );
    expect(usesSonarrNextEpisode(new Set(['episodesAiringToday']))).toBe(false);
  });

  it.each([
    'daysUntilNextSeason',
    'daysUntilNextEpisode',
    'nextSeasonAirDate',
    'seasonNumber',
    'daysAgo',
  ])('is on for %s', (field) => {
    expect(usesSonarrNextEpisode(new Set([field]))).toBe(true);
  });
});

describe('usesSonarrEpisodeSummary', () => {
  it.each([
    'nextEpisodeDownloaded',
    'nextSeasonDownloaded',
    'nextUndownloadedEpisodeDate',
    'daysUntilNextUndownloadedEpisode',
    'nextUndownloadedSeasonNumber',
    'nextUndownloadedEpisodeNumber',
  ])('is on for %s', (field) => {
    expect(usesSonarrEpisodeSummary(new Set([field]))).toBe(true);
    expect(shouldSkipOnReleaseDateFetchFailure(new Set([field]))).toBe(true);
  });

  it('is off for a library that reads none of them', () => {
    expect(usesSonarrEpisodeSummary(new Set(['daysUntilNextSeason']))).toBe(
      false
    );
  });
});

describe('needsSonarrEpisodeList', () => {
  const flags = new Set(['nextSeasonDownloaded', 'daysUntilNextSeason']);

  it('the downloaded flags alone need the list only when something is upcoming', () => {
    expect(needsSonarrEpisodeList(flags, false)).toBe(false);
    expect(needsSonarrEpisodeList(flags, true)).toBe(true);
  });

  it('any other summary field always needs it', () => {
    expect(
      needsSonarrEpisodeList(new Set(['episodesAiringToday']), false)
    ).toBe(true);
    expect(
      needsSonarrEpisodeList(
        new Set(['nextSeasonDownloaded', 'nextUndownloadedEpisodeNumber']),
        false
      )
    ).toBe(true);
  });

  it('no summary field never needs it; unknown fields always do', () => {
    expect(needsSonarrEpisodeList(new Set(['title']), true)).toBe(false);
    expect(needsSonarrEpisodeList(undefined, false)).toBe(true);
  });
});

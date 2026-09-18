import type { TmdbSeasonWithEpisodes } from '@server/api/themoviedb/interfaces';
import { describe, expect, it } from 'vitest';
import {
  extractTmdbId,
  getTmdbEpisodeRatingContext,
  getTmdbSeasonRatingContext,
  toTmdbRatingContext,
  usesTmdbRatingFields,
} from './tmdbRatingPolicy';

const season = {
  id: 100,
  name: 'Season 2',
  season_number: 2,
  air_date: '2025-01-01',
  overview: '',
  vote_average: 8.25,
  episodes: [
    {
      id: 201,
      air_date: '2025-01-01',
      episode_number: 1,
      name: 'Rated',
      overview: '',
      production_code: '',
      season_number: 2,
      show_id: 10,
      still_path: '',
      vote_average: 8.74,
      vote_count: 125,
    },
    {
      id: 202,
      air_date: '2025-01-08',
      episode_number: 2,
      name: 'Unrated',
      overview: '',
      production_code: '',
      season_number: 2,
      show_id: 10,
      still_path: '',
      vote_average: 0,
      vote_count: 0,
    },
  ],
  external_ids: {},
} as TmdbSeasonWithEpisodes;

describe('TMDB rating policy', () => {
  it('only enables TMDB lookups for templates that use TMDB rating fields', () => {
    expect(usesTmdbRatingFields(new Set())).toBe(false);
    expect(usesTmdbRatingFields(new Set(['tmdbRating']))).toBe(true);
    expect(usesTmdbRatingFields(new Set(['tmdbVoteCount']))).toBe(true);
  });

  it('extracts a show TMDB id from Plex GUIDs', () => {
    expect(extractTmdbId([{ id: 'imdb://tt123' }, { id: 'tmdb://1396' }])).toBe(
      1396
    );
    expect(extractTmdbId([{ id: 'tmdb://not-a-number' }])).toBeUndefined();
  });

  it('treats TMDB zero values as missing instead of real ratings', () => {
    expect(toTmdbRatingContext(0, 0)).toEqual({
      tmdbRating: undefined,
      tmdbVoteCount: 0,
    });
    expect(toTmdbRatingContext(9.1, 0)).toEqual({
      tmdbRating: undefined,
      tmdbVoteCount: 0,
    });
  });

  it("uses the season's own rating", () => {
    expect(getTmdbSeasonRatingContext(season)).toEqual({
      tmdbRating: 8.25,
      tmdbVoteCount: undefined,
    });
  });

  it('selects the exact episode rating and never falls back', () => {
    expect(getTmdbEpisodeRatingContext(season, 1)).toEqual({
      tmdbRating: 8.74,
      tmdbVoteCount: 125,
    });
    expect(getTmdbEpisodeRatingContext(season, 2)).toEqual({
      tmdbRating: undefined,
      tmdbVoteCount: 0,
    });
    expect(getTmdbEpisodeRatingContext(season, 99)).toEqual({
      tmdbRating: undefined,
      tmdbVoteCount: undefined,
    });
  });
});

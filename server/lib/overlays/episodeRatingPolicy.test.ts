import { describe, expect, it } from 'vitest';
import {
  getEpisodeRatingEligibility,
  getUnratedEpisodeAction,
} from './episodeRatingPolicy';

describe('episode rating eligibility', () => {
  it('accepts only an episode IMDb GUID with a numeric cached rating', () => {
    expect(
      getEpisodeRatingEligibility(
        [{ id: 'imdb://tt123' }],
        new Map([['tt123', 8.4]])
      )
    ).toEqual({ imdbId: 'tt123', rating: 8.4, eligible: true });
  });

  it.each([
    ['no IMDb GUID', [{ id: 'tmdb://123' }], new Map()],
    ['no rating response', [{ id: 'imdb://tt123' }], new Map()],
    [
      'confirmed missing rating',
      [{ id: 'imdb://tt123' }],
      new Map([['tt123', null]]),
    ],
    ['unavailable rating cache', [{ id: 'imdb://tt123' }], undefined],
  ])('rejects an episode with %s', (_label, guids, ratings) => {
    expect(getEpisodeRatingEligibility(guids, ratings).eligible).toBe(false);
  });

  it('restores only cards that Agregarr previously overlaid', () => {
    expect(getUnratedEpisodeAction(true)).toBe('restore-base');
    expect(getUnratedEpisodeAction(false)).toBe('keep-clean');
  });
});

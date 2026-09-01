import type { PlexLibraryItem } from '@server/api/plexapi';
import { describe, expect, it } from 'vitest';
import { calculateSeasonImdbRatings } from './seasonRatingPolicy';

const episode = (
  ratingKey: string,
  seasonRatingKey: string,
  imdbId?: string
): PlexLibraryItem =>
  ({
    ratingKey,
    parentRatingKey: seasonRatingKey,
    title: ratingKey,
    type: 'episode',
    Guid: imdbId ? [{ id: `imdb://${imdbId}` }] : undefined,
  } as PlexLibraryItem);

describe('season IMDb rating policy', () => {
  it('averages each season from its own episode IMDb ratings', () => {
    const ratings = new Map<string, number | null>([
      ['tt101', 7.1],
      ['tt102', 8.2],
      ['tt201', 9.4],
    ]);

    expect(
      calculateSeasonImdbRatings(
        [
          episode('episode-101', 'season-1', 'tt101'),
          episode('episode-102', 'season-1', 'tt102'),
          episode('episode-201', 'season-2', 'tt201'),
        ],
        ratings
      )
    ).toEqual(
      new Map([
        ['season-1', 7.7],
        ['season-2', 9.4],
      ])
    );
  });

  it('ignores episodes with missing or null IMDb ratings', () => {
    const ratings = new Map<string, number | null>([
      ['tt101', 8.3],
      ['tt102', null],
    ]);

    expect(
      calculateSeasonImdbRatings(
        [
          episode('episode-101', 'season-1', 'tt101'),
          episode('episode-102', 'season-1', 'tt102'),
          episode('episode-103', 'season-1'),
        ],
        ratings
      )
    ).toEqual(new Map([['season-1', 8.3]]));
  });

  it('returns no season rating when none of its episodes are rated', () => {
    expect(
      calculateSeasonImdbRatings(
        [episode('episode-101', 'season-1', 'tt101')],
        new Map([['tt101', null]])
      )
    ).toEqual(new Map());
  });

  it('does not count a duplicate episode twice', () => {
    const duplicate = episode('episode-101', 'season-1', 'tt101');

    expect(
      calculateSeasonImdbRatings(
        [duplicate, duplicate, episode('episode-102', 'season-1', 'tt102')],
        new Map([
          ['tt101', 4],
          ['tt102', 8],
        ])
      )
    ).toEqual(new Map([['season-1', 6]]));
  });
});

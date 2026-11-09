import {
  countFranchiseParts,
  franchisesWithTooFewReleased,
} from '@server/lib/collections/utils/franchiseParts';
import { describe, expect, it } from 'vitest';

const now = new Date(2026, 10, 9, 23, 30);

const movies = [
  { releaseDate: '2019-06-21' },
  { releaseDate: '2026-11-09' },
  { releaseDate: '2026-11-10' },
  { releaseDate: '2031-01-01' },
  { releaseDate: '' },
  {},
];

describe('countFranchiseParts', () => {
  it('counts every part when the option is off', () => {
    expect(countFranchiseParts(movies, false, now)).toBe(6);
  });

  it('counts only parts released on or before today when on', () => {
    expect(countFranchiseParts(movies, true, now)).toBe(2);
  });

  it('does not count future-dated or undated parts', () => {
    expect(
      countFranchiseParts(
        [{ releaseDate: '2031-01-01' }, { releaseDate: '' }],
        true,
        now
      )
    ).toBe(0);
  });
});

describe('franchisesWithTooFewReleased', () => {
  const franchise = (...dates: string[]) => ({
    movies: dates.map((releaseDate) => ({ releaseDate })),
  });
  const all = new Map([
    [1, franchise('2013-06-19', '')],
    [2, franchise('2011-04-03', '2014-03-19', '')],
    [3, franchise('2020-01-01')],
    [4, franchise('2026-11-09', '2027-05-01')],
  ]);

  it('returns only franchises dropped by the released count, with that count', () => {
    const kept = new Map([...all].filter(([id]) => id === 2));
    expect(franchisesWithTooFewReleased(all, kept, 2, new Set(), now)).toEqual(
      new Map([
        [1, 1],
        [4, 1],
      ])
    );
  });

  it('returns nothing when every multi-part franchise was kept', () => {
    const kept = new Map([...all].filter(([id]) => id !== 3));
    expect(
      franchisesWithTooFewReleased(all, kept, 2, new Set(), now).size
    ).toBe(0);
  });
});

describe('owned films count as released', () => {
  it('counts an owned part TMDB has undated or future-dated', () => {
    const parts = [
      { tmdbId: 1, releaseDate: '2019-01-01' },
      { tmdbId: 2, releaseDate: '' },
      { tmdbId: 3, releaseDate: '2031-01-01' },
    ];
    expect(countFranchiseParts(parts, true, now)).toBe(1);
    expect(countFranchiseParts(parts, true, now, new Set([2, 3]))).toBe(3);
  });

  it('does not select a franchise for removal when owned parts make it qualify', () => {
    const all = new Map([
      [
        7,
        {
          movies: [
            { tmdbId: 1, releaseDate: '2019-01-01' },
            { tmdbId: 2, releaseDate: '' },
          ],
        },
      ],
    ]);
    expect(
      franchisesWithTooFewReleased(all, new Map(), 2, new Set([2]), now).size
    ).toBe(0);
    expect(
      franchisesWithTooFewReleased(all, new Map(), 2, new Set(), now)
    ).toEqual(new Map([[7, 1]]));
  });
});

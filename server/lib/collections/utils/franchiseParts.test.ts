import { countFranchiseParts } from '@server/lib/collections/utils/franchiseParts';
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

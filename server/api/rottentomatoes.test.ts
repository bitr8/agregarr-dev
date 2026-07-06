import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({ clientId: 'test-client-id' }),
}));

vi.mock('@server/lib/cache', () => ({
  default: {
    getCache: () => ({ data: undefined }),
  },
}));

import RottenTomatoes from './rottentomatoes';

const makeScores = (criticsScore: number, audienceScore: number) => ({
  audienceScore,
  criticsIconUrl: '',
  wantToSeeCount: 0,
  audienceIconUrl: '',
  scoreSentiment: 'POSITIVE',
  certifiedFresh: false,
  verifiedHot: false,
  criticsScore,
});

// Fixtures mirror the live Algolia response for the query
// "Harry Potter and the Philosopher's Stone" (upstream #582):
// a 2026 TV entry whose main title matches exactly, and the 2001 movie
// whose main title says "Sorcerer's" with "Philosopher's" only in `aka`.
// Note RT's `titles` array contains prefix fragments of the main title.
const philosopherTvHit = {
  title: "Harry Potter and the Philosopher's Stone",
  type: 'tv',
  releaseYear: 2026,
  titles: [
    "Harry Potter and the Philosopher's Stone",
    'Harry Potter and the',
    'Harry',
  ],
  aka: [],
  vanity: 'harry_potter_tv',
  rottenTomatoes: makeScores(55, 50),
};

const sorcererMovieHit = {
  title: "Harry Potter and the Sorcerer's Stone",
  type: 'movie',
  releaseYear: 2001,
  titles: ["Harry Potter and the Sorcerer's Stone", 'Potter', 'Harry'],
  aka: [
    "Harry Potter and the Philosopher's Stone",
    'Harry Potter e la pietra filosofale',
    'Harry Potter og de vises sten',
  ],
  vanity: 'harry_potter_and_the_sorcerers_stone',
  rottenTomatoes: makeScores(80, 82),
};

// Generic single-word `aka` ("Home") on an unrelated film. The year gate
// is the only mitigation for this class of collision — accepted risk by
// design (see the hasMatchingAltTitle doc comment).
const genericAkaMovieHit = {
  title: 'Une Époque Formidable',
  type: 'movie',
  releaseYear: 1991,
  titles: ['Une Époque Formidable'],
  aka: ['Home'],
  vanity: 'une_epoque_formidable',
  rottenTomatoes: makeScores(70, 65),
};

// Same Roman-numeral title in both media types, same year — used to prove
// the Roman numeral fallback (rule 8) is type-guarded. Both have ratings
// data so a null result proves non-selection rather than selected-but-empty.
const halloweenTvHit = {
  title: 'Halloween III',
  type: 'tv',
  releaseYear: 1982,
  titles: ['Halloween III'],
  aka: [],
  vanity: 'halloween_iii_tv',
  rottenTomatoes: makeScores(40, 45),
};

const halloweenMovieHit = {
  title: 'Halloween III',
  type: 'movie',
  releaseYear: 1982,
  titles: ['Halloween III'],
  aka: [],
  vanity: 'halloween_iii',
  rottenTomatoes: makeScores(35, 52),
};

const createRT = (hits: Record<string, unknown>[]) => {
  const rt = new RottenTomatoes();
  const post = vi.fn().mockResolvedValue({
    results: [{ index: 'content_rt', hits }],
  });
  (rt as unknown as { post: typeof post }).post = post;

  return rt;
};

describe('RottenTomatoes getMovieRatings', () => {
  it('resolves an international title via aka + year (upstream #582)', async () => {
    // TV entry listed first, as in the live response
    const rt = createRT([philosopherTvHit, sorcererMovieHit]);

    const rating = await rt.getMovieRatings(
      "Harry Potter and the Philosopher's Stone",
      2001
    );

    expect(rating).not.toBeNull();
    expect(rating?.title).toBe("Harry Potter and the Sorcerer's Stone");
    expect(rating?.year).toBe(2001);
    // Movie's scores, not the same-named TV entry's
    expect(rating?.criticsScore).toBe(80);
    expect(rating?.url).toContain('/m/');
  });

  it('does not cross-match a same-named TV entry on the title-only rule', async () => {
    // Only the TV entry exists. It has ratings data, so a null result
    // proves it was never selected rather than selected-but-empty.
    const rt = createRT([philosopherTvHit]);

    const rating = await rt.getMovieRatings(
      "Harry Potter and the Philosopher's Stone",
      2001
    );

    expect(rating).toBeNull();
  });

  it('does not match a generic aka entry without a matching year', async () => {
    const rt = createRT([genericAkaMovieHit]);

    const rating = await rt.getMovieRatings('Home', 2020);

    expect(rating).toBeNull();
  });

  it('accepts a generic aka match when the year also matches (accepted risk by design)', async () => {
    const rt = createRT([genericAkaMovieHit]);

    // The year gate is the ONLY mitigation for generic aka collisions:
    // within the gate the alt-title rules intentionally accept the hit.
    // If a future refactor tightens hasMatchingAltTitle or drops rules
    // 5/6, this locks in the intended behaviour.
    const exactYear = await rt.getMovieRatings('Home', 1991);

    expect(exactYear?.title).toBe('Une Époque Formidable');
    expect(exactYear?.criticsScore).toBe(70);

    const offByOneYear = await rt.getMovieRatings('Home', 1992);

    expect(offByOneYear?.title).toBe('Une Époque Formidable');
  });

  it('does not match a short title fragment from the titles array without a matching year', async () => {
    // "Harry" appears in the movie's `titles` array as a prefix fragment
    const rt = createRT([sorcererMovieHit]);

    const rating = await rt.getMovieRatings('Harry', 2010);

    expect(rating).toBeNull();
  });

  it('does not cross-match a same-titled TV entry on the Roman numeral rule', async () => {
    // Only a TV "Halloween III" exists within +-1 year. The Roman numeral
    // fallback must not select it for a movie lookup.
    const rt = createRT([halloweenTvHit]);

    const rating = await rt.getMovieRatings('Halloween 3', 1982);

    expect(rating).toBeNull();
  });

  it('still matches a movie via the Roman numeral rule (existing behaviour)', async () => {
    // TV entry listed first to prove it is skipped, not just absent
    const rt = createRT([halloweenTvHit, halloweenMovieHit]);

    const rating = await rt.getMovieRatings('Halloween 3', 1982);

    expect(rating?.title).toBe('Halloween III');
    expect(rating?.criticsScore).toBe(35);
    expect(rating?.url).toContain('/m/');
  });

  it('still matches exact title + year (existing behaviour)', async () => {
    const rt = createRT([philosopherTvHit, sorcererMovieHit]);

    const rating = await rt.getMovieRatings(
      "Harry Potter and the Sorcerer's Stone",
      2001
    );

    expect(rating?.title).toBe("Harry Potter and the Sorcerer's Stone");
    expect(rating?.criticsScore).toBe(80);
  });
});

describe('RottenTomatoes getTVRatings', () => {
  const moneyHeistHit = {
    title: 'Money Heist',
    type: 'tv',
    releaseYear: 2017,
    titles: ['Money Heist'],
    aka: ['La Casa de Papel'],
    vanity: 'money_heist',
    rottenTomatoes: makeScores(78, 84),
  };

  it('resolves an international title via aka + year', async () => {
    const rt = createRT([moneyHeistHit]);

    const rating = await rt.getTVRatings('La Casa de Papel', 2017);

    expect(rating).not.toBeNull();
    expect(rating?.title).toBe('Money Heist');
    expect(rating?.url).toContain('/tv/');
  });

  it('does not cross-match a same-named movie on the title-only rule (with year)', async () => {
    // Movie with the exact same title but a far-off year, with ratings
    // data present so null proves non-selection
    const rt = createRT([sorcererMovieHit]);

    const rating = await rt.getTVRatings(
      "Harry Potter and the Sorcerer's Stone",
      2026
    );

    expect(rating).toBeNull();
  });

  it('does not cross-match a same-named movie when no year is provided', async () => {
    const rt = createRT([sorcererMovieHit]);

    const rating = await rt.getTVRatings(
      "Harry Potter and the Sorcerer's Stone"
    );

    expect(rating).toBeNull();
  });

  it('does not match a generic aka entry without a matching year', async () => {
    const rt = createRT([moneyHeistHit]);

    const rating = await rt.getTVRatings('La Casa de Papel', 2005);

    expect(rating).toBeNull();
  });

  it('does not cross-match a same-titled movie on the Roman numeral rule', async () => {
    // Only a movie "Halloween III" exists within +-1 year. The Roman
    // numeral fallback must not select it for a TV lookup.
    const rt = createRT([halloweenMovieHit]);

    const rating = await rt.getTVRatings('Halloween 3', 1982);

    expect(rating).toBeNull();
  });

  it('still matches a TV show via the Roman numeral rule (existing behaviour)', async () => {
    // Movie entry listed first to prove it is skipped, not just absent
    const rt = createRT([halloweenMovieHit, halloweenTvHit]);

    const rating = await rt.getTVRatings('Halloween 3', 1982);

    expect(rating?.title).toBe('Halloween III');
    expect(rating?.criticsScore).toBe(40);
    expect(rating?.url).toContain('/tv/');
  });

  it('still matches exact title + year (existing behaviour)', async () => {
    const rt = createRT([moneyHeistHit]);

    const rating = await rt.getTVRatings('Money Heist', 2017);

    expect(rating?.title).toBe('Money Heist');
    expect(rating?.criticsScore).toBe(78);
  });

  it('matches exact TV title without a year (existing behaviour)', async () => {
    const rt = createRT([sorcererMovieHit, moneyHeistHit]);

    const rating = await rt.getTVRatings('Money Heist');

    expect(rating?.title).toBe('Money Heist');
  });
});

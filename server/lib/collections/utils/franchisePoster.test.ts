import {
  pickFranchisePoster,
  toImageLanguage,
} from '@server/lib/collections/utils/franchisePoster';
import { describe, expect, it } from 'vitest';

// Shape of a /collection/{id}/images?include_image_language=sv,en,null response
const poster = (
  iso: string | null,
  voteAverage: number,
  voteCount: number,
  name: string
) => ({
  aspect_ratio: 0.667,
  height: 1500,
  width: 1000,
  iso_639_1: iso,
  file_path: `/${name}.jpg`,
  vote_average: voteAverage,
  vote_count: voteCount,
});

const posters = [
  poster('en', 3.334, 1, 'en-top'),
  poster('en', 2.278, 3, 'en-mid'),
  poster('en', 0.958, 4, 'en-low'),
  poster(null, 0, 0, 'none'),
  poster('sv', 1.5, 2, 'sv-low'),
  poster('sv', 5.1, 6, 'sv-top'),
  poster('sv', 5.1, 2, 'sv-tie'),
];

describe('toImageLanguage', () => {
  it('reduces a locale to its ISO-639-1 code', () => {
    expect(toImageLanguage('sv-SE')).toBe('sv');
    expect(toImageLanguage('pt_BR')).toBe('pt');
    expect(toImageLanguage('en')).toBe('en');
  });
});

describe('pickFranchisePoster', () => {
  it('prefers the configured language, best vote_average then vote_count', () => {
    expect(pickFranchisePoster(posters, 'sv-SE')).toBe('/sv-top.jpg');
  });

  it('breaks vote_average ties on vote_count', () => {
    expect(pickFranchisePoster([posters[6], posters[5]], 'sv')).toBe(
      '/sv-top.jpg'
    );
  });

  it('falls back to en when the configured language has no poster', () => {
    expect(pickFranchisePoster(posters, 'de')).toBe('/en-top.jpg');
  });

  it('falls back to the no-language poster after en', () => {
    expect(pickFranchisePoster([posters[3]], 'de')).toBe('/none.jpg');
  });

  it('uses en then no-language when the configured language is en', () => {
    expect(pickFranchisePoster(posters, 'en')).toBe('/en-top.jpg');
    expect(pickFranchisePoster([posters[3]], 'en')).toBe('/none.jpg');
  });

  it('ignores posters in other languages and returns undefined when none match', () => {
    expect(pickFranchisePoster([poster('zh', 9, 9, 'zh')], 'sv')).toBe(
      undefined
    );
    expect(pickFranchisePoster([], 'sv')).toBe(undefined);
  });
});

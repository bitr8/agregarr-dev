import { describe, expect, it } from 'vitest';
import { extractTvdbTmdbId, parseTvdbListInput } from './index';

describe('parseTvdbListInput', () => {
  it.each([
    ['https://thetvdb.com/lists/matrix', { slug: 'matrix' }],
    ['https://www.thetvdb.com/lists/matrix/', { slug: 'matrix' }],
    ['https://thetvdb.com/lists/7149', { id: 7149 }],
    ['https://thetvdb.com/lists/7149?foo=bar', { id: 7149 }],
    ['https://thetvdb.com/lists/Star-Wars_2', { slug: 'star-wars_2' }],
    ['7149', { id: 7149 }],
    ['lists/matrix', { slug: 'matrix' }],
  ])('%s', (input, expected) => {
    expect(parseTvdbListInput(input)).toEqual(expected);
  });

  it.each([
    '',
    'https://thetvdb.com/series/some-show',
    'https://thetvdb.com/lists',
    'https://example.com/lists/matrix',
    'https://thetvdb.com.evil.test/lists/matrix',
    'not a url !',
  ])('rejects %s', (input) => {
    expect(parseTvdbListInput(input)).toBeNull();
  });
});

describe('extractTvdbTmdbId', () => {
  const remoteIds = [
    { id: 'tt0113568', type: 2, sourceName: 'IMDB' },
    { id: 'https://example.test/', type: 4, sourceName: 'Official Website' },
    { id: '9323', type: 10, sourceName: 'TheMovieDB.com' },
  ];

  it('reads the TMDB entry from remoteIds', () => {
    expect(extractTvdbTmdbId(remoteIds)).toBe(9323);
  });

  it('returns undefined when absent, null or non-numeric', () => {
    expect(extractTvdbTmdbId(remoteIds.slice(0, 2))).toBeUndefined();
    expect(extractTvdbTmdbId(null)).toBeUndefined();
    expect(
      extractTvdbTmdbId([{ id: 'abc', type: 10, sourceName: 'TheMovieDB.com' }])
    ).toBeUndefined();
  });
});

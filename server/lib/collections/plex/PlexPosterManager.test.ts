import { describe, expect, it } from 'vitest';
import {
  resolvePlexPosterDownloadPath,
  selectPreferredPosterReference,
} from './posterSelection';

describe('selectPreferredPosterReference', () => {
  it('prefers a selected Posterizarr-style upload over an earlier TMDB poster', () => {
    expect(
      selectPreferredPosterReference([
        {
          ratingKey: 'https://image.tmdb.org/t/p/original/tmdb.jpg',
          thumb: '/library/metadata/42/thumb/tmdb',
        },
        {
          ratingKey: 'upload://posters/425574157063dce0',
          thumb: '/library/metadata/42/thumb/425574157063dce0',
          selected: '1',
        },
      ])
    ).toBe('upload://posters/425574157063dce0');
  });

  it('keeps a selected metadata poster when no uploaded poster is selected', () => {
    expect(
      selectPreferredPosterReference([
        {
          ratingKey: 'metadata://posters/tv.plex.agents.movie_hash',
          selected: 1,
        },
      ])
    ).toBe('metadata://posters/tv.plex.agents.movie_hash');
  });

  it('does not guess between uploads when Plex omits selected markers', () => {
    expect(
      selectPreferredPosterReference([
        { ratingKey: 'https://image.tmdb.org/t/p/original/tmdb.jpg' },
        { ratingKey: 'upload://posters/old-manual-upload' },
        { ratingKey: 'upload://posters/posterizarr-hash' },
      ])
    ).toBeNull();
  });

  it('chooses the selected upload when several uploads exist', () => {
    expect(
      selectPreferredPosterReference([
        { ratingKey: 'upload://posters/old-manual-upload' },
        {
          ratingKey: 'upload://posters/posterizarr-hash',
          selected: true,
        },
        { ratingKey: 'upload://posters/old-agregarr-overlay' },
      ])
    ).toBe('upload://posters/posterizarr-hash');
  });

  it('normalizes a selected encoded upload reference', () => {
    expect(
      selectPreferredPosterReference([
        {
          key: '/library/metadata/42/file?url=upload%3A%2F%2Fposters%2Fposterizarr-hash',
          selected: '1',
        },
      ])
    ).toBe('upload://posters/posterizarr-hash');
  });

  it('returns null when no poster is usable', () => {
    expect(selectPreferredPosterReference([])).toBeNull();
  });
});

describe('resolvePlexPosterDownloadPath', () => {
  it('uses the exact-file endpoint for uploaded posters', () => {
    expect(
      resolvePlexPosterDownloadPath('upload://posters/posterizarr-hash', '42')
    ).toBe(
      '/library/metadata/42/file?url=upload%3A%2F%2Fposters%2Fposterizarr-hash'
    );
  });

  it('uses the exact-file endpoint for Plex metadata posters', () => {
    expect(
      resolvePlexPosterDownloadPath(
        'metadata://posters/tv.plex.agents.movie_hash',
        '42'
      )
    ).toBe(
      '/library/metadata/42/file?url=metadata%3A%2F%2Fposters%2Ftv.plex.agents.movie_hash'
    );
  });

  it('leaves ordinary Plex thumb paths unchanged', () => {
    expect(
      resolvePlexPosterDownloadPath('/library/metadata/42/thumb/1234', '42')
    ).toBe('/library/metadata/42/thumb/1234');
  });
});

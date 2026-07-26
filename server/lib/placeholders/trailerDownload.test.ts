import type { TmdbVideo } from '@server/api/themoviedb/interfaces';
import { describe, expect, it } from 'vitest';
import { selectTmdbTrailer, titlePassesWordFilter } from './trailerDownload';

function makeVideo(overrides: Partial<TmdbVideo> = {}): TmdbVideo {
  return {
    id: '1',
    key: 'dQw4w9WgXcQ',
    name: 'Official Trailer',
    site: 'YouTube',
    size: 1080,
    type: 'Trailer',
    official: true,
    iso_639_1: 'en',
    iso_3166_1: 'US',
    published_at: '2026-01-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('titlePassesWordFilter', () => {
  it('passes when no filters', () => {
    expect(titlePassesWordFilter('Official Trailer', [], [])).toBe(true);
  });

  it('rejects on exclude word match', () => {
    expect(
      titlePassesWordFilter(
        'Behind The Scenes Making Of',
        [],
        ['behind the scenes']
      )
    ).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(titlePassesWordFilter('REVIEW of Movie', [], ['review'])).toBe(
      false
    );
  });

  it('requires ALL include words', () => {
    expect(
      titlePassesWordFilter('Official Trailer HD', ['official', 'trailer'], [])
    ).toBe(true);
    expect(
      titlePassesWordFilter('Official Teaser HD', ['official', 'trailer'], [])
    ).toBe(false);
  });

  it('exclude takes priority over include', () => {
    expect(
      titlePassesWordFilter('Official Trailer Review', ['trailer'], ['review'])
    ).toBe(false);
  });
});

describe('selectTmdbTrailer', () => {
  it('filters non-YouTube sites', () => {
    const videos = [makeVideo({ site: 'Vimeo' }), makeVideo({ key: 'yt1' })];
    const result = selectTmdbTrailer(videos, []);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('yt1');
  });

  it('filters non-Trailer/Teaser types', () => {
    const videos = [
      makeVideo({ type: 'Featurette', key: 'feat' }),
      makeVideo({ type: 'Trailer', key: 'tr' }),
      makeVideo({ type: 'Behind the Scenes', key: 'bts' }),
    ];
    const result = selectTmdbTrailer(videos, []);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('tr');
  });

  it('applies exclude words to video names', () => {
    const videos = [
      makeVideo({
        name: 'OWN IT ON BLU-RAY & DVD!',
        type: 'Teaser',
        key: 'promo',
      }),
      makeVideo({ name: 'Official Teaser', type: 'Teaser', key: 'good' }),
    ];
    const result = selectTmdbTrailer(videos, ['blu-ray']);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('good');
  });

  it('ranks Trailer above Teaser', () => {
    const videos = [
      makeVideo({
        type: 'Teaser',
        key: 'teas',
        published_at: '2026-06-01T00:00:00.000Z',
      }),
      makeVideo({
        type: 'Trailer',
        key: 'trail',
        published_at: '2026-01-01T00:00:00.000Z',
      }),
    ];
    const result = selectTmdbTrailer(videos, []);
    expect(result[0].key).toBe('trail');
  });

  it('ranks official above non-official within same type', () => {
    const videos = [
      makeVideo({ official: false, key: 'unoff' }),
      makeVideo({ official: true, key: 'off' }),
    ];
    const result = selectTmdbTrailer(videos, []);
    expect(result[0].key).toBe('off');
  });

  it('ranks newer published_at first within same type and official', () => {
    const videos = [
      makeVideo({ published_at: '2025-12-01T00:00:00.000Z', key: 'old' }),
      makeVideo({ published_at: '2026-06-15T00:00:00.000Z', key: 'new' }),
    ];
    const result = selectTmdbTrailer(videos, []);
    expect(result[0].key).toBe('new');
  });

  it('returns empty for no matching videos', () => {
    const videos = [makeVideo({ site: 'Vimeo' })];
    expect(selectTmdbTrailer(videos, [])).toHaveLength(0);
  });
});

import type { PlexLibraryItem } from '@server/api/plexapi';
import { describe, expect, it } from 'vitest';
import { collectImdbPrefetchCandidates } from './imdbPrefetchCandidates';

const item = (
  type: PlexLibraryItem['type'],
  ratingKey: string,
  guids: string[]
): PlexLibraryItem => ({
  ratingKey,
  title: ratingKey,
  type,
  guid: '',
  Guid: guids.map((id) => ({ id })),
  Media: [],
  addedAt: 0,
  updatedAt: 0,
});

describe('IMDb prefetch candidates', () => {
  it('includes episode IMDb GUIDs but excludes season IMDb GUIDs', () => {
    const candidates = collectImdbPrefetchCandidates([
      item('show', 'show', ['imdb://tt100']),
      item('season', 'season', ['imdb://tt200']),
      item('episode', 'episode', ['imdb://tt300']),
    ]);

    expect(Array.from(candidates.imdbData.keys())).toEqual(['tt100', 'tt300']);
    expect(candidates.processableItems).toBe(2);
  });

  it('does not treat an episode TMDB ID as a show ID', () => {
    const candidates = collectImdbPrefetchCandidates([
      item('episode', 'episode', ['tmdb://9876']),
    ]);

    expect(candidates.needTmdbLookup).toEqual([]);
  });

  it('retains movie and show TMDB fallback lookups independently', () => {
    const candidates = collectImdbPrefetchCandidates([
      item('movie', 'movie', ['tmdb://42']),
      item('show', 'show', ['tmdb://42']),
    ]);

    expect(candidates.needTmdbLookup).toEqual([
      { tmdbId: 42, itemType: 'movie', year: undefined },
      { tmdbId: 42, itemType: 'show', year: undefined },
    ]);
  });
});

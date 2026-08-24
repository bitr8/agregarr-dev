import type { PlexLibraryItem } from '@server/api/plexapi';
import { describe, expect, it } from 'vitest';
import {
  buildOverlaySyncItems,
  buildSpecificOverlayItem,
} from './overlaySyncItems';

describe('overlay sync item expansion', () => {
  it('keeps season context tied to its parent show', () => {
    const items = [
      {
        ratingKey: 'season-1',
        parentRatingKey: 'show-1',
        parentTitle: 'The Show',
        title: 'Season 2',
        type: 'season',
        index: 2,
      },
    ] as PlexLibraryItem[];

    expect(buildOverlaySyncItems(items, 'season')).toEqual([
      {
        ratingKey: 'season-1',
        title: 'The Show - Season 2',
        target: 'season',
        contextFallbackRatingKey: 'show-1',
        contextOverrides: { seasonNumber: 2, episodeNumber: undefined },
      },
    ]);
  });

  it('keeps episode, season, and parent-show context together', () => {
    const items = [
      {
        ratingKey: 'episode-1',
        grandparentRatingKey: 'show-1',
        grandparentTitle: 'The Show',
        title: 'Episode 8',
        type: 'episode',
        parentIndex: 3,
        index: 8,
      },
    ] as PlexLibraryItem[];

    expect(buildOverlaySyncItems(items, 'episode')).toEqual([
      {
        ratingKey: 'episode-1',
        title: 'The Show - S03E08 - Episode 8',
        target: 'episode',
        contextFallbackRatingKey: 'show-1',
        contextOverrides: { seasonNumber: 3, episodeNumber: 8 },
      },
    ]);
  });

  it('uses the resolved per-season IMDb rating instead of the show fallback', () => {
    const items = [
      {
        ratingKey: 'season-1',
        parentRatingKey: 'show-1',
        title: 'Season 1',
        type: 'season',
        index: 1,
      },
      {
        ratingKey: 'season-2',
        parentRatingKey: 'show-1',
        title: 'Season 2',
        type: 'season',
        index: 2,
      },
    ] as PlexLibraryItem[];

    expect(
      buildOverlaySyncItems(items, 'season', new Map([['season-1', 8.4]]))
    ).toEqual([
      expect.objectContaining({
        ratingKey: 'season-1',
        contextOverrides: {
          seasonNumber: 1,
          episodeNumber: undefined,
          imdbRating: 8.4,
        },
      }),
      expect.objectContaining({
        ratingKey: 'season-2',
        contextOverrides: {
          seasonNumber: 2,
          episodeNumber: undefined,
          imdbRating: undefined,
        },
      }),
    ]);
  });

  it('rejects Plex items that do not match the requested child target', () => {
    const movie = {
      ratingKey: 'movie-1',
      title: 'Movie',
      type: 'movie',
    } as PlexLibraryItem;

    expect(buildOverlaySyncItems([movie], 'season')).toEqual([]);
  });

  it('retains an episode file path for sync outcome details', () => {
    const item = {
      ratingKey: 'episode-1',
      grandparentRatingKey: 'show-1',
      title: 'Pilot',
      type: 'episode',
      Media: [{ Part: [{ file: '/tv/The Show/Season 01/Pilot.mkv' }] }],
    } as PlexLibraryItem;

    expect(buildOverlaySyncItems([item], 'episode')[0]).toMatchObject({
      ratingKey: 'episode-1',
      filePath: '/tv/The Show/Season 01/Pilot.mkv',
    });
  });

  it('infers the correct target and show fallback for manually selected media', () => {
    const episode = {
      ratingKey: 'episode-8',
      grandparentRatingKey: 'show-1',
      grandparentTitle: 'The Show',
      title: 'Finale',
      type: 'episode',
      parentIndex: 2,
      index: 8,
    } as PlexLibraryItem;

    expect(buildSpecificOverlayItem(episode)).toEqual({
      ratingKey: 'episode-8',
      title: 'The Show - S02E08 - Finale',
      target: 'episode',
      contextFallbackRatingKey: 'show-1',
      contextOverrides: { seasonNumber: 2, episodeNumber: 8 },
    });
  });
});

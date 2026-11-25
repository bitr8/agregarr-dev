import type { PlexLibraryItem } from '@server/api/plexapi';
import { describe, expect, it } from 'vitest';
import {
  findPlaceholderShowKeys,
  hasOwnSeasonPoster,
  partitionPlaceholderSeasons,
  plexPlaceholderShowResolver,
  shouldSkipPlaceholderSeason,
} from './placeholderSeasons';

const season = (
  ratingKey: string,
  parentRatingKey: string,
  thumb?: string,
  index = 0
) =>
  ({
    ratingKey,
    parentRatingKey,
    thumb,
    index,
    type: 'season',
  } as unknown as PlexLibraryItem);

const show = (ratingKey: string, editionTitle?: string) =>
  ({ ratingKey, editionTitle, type: 'show' } as unknown as PlexLibraryItem);

describe('placeholder season skipping', () => {
  const inherited = season('s1', 'show1', '/library/metadata/show1/thumb/1');
  const own = season('s2', 'show2', '/library/metadata/s2/thumb/1');

  it('detects whether a season has its own poster', () => {
    expect(hasOwnSeasonPoster(inherited)).toBe(false);
    expect(hasOwnSeasonPoster(own)).toBe(true);
    expect(hasOwnSeasonPoster(season('s3', 'show3'))).toBe(false);
  });

  it('skips only a poster-less season of a placeholder show', () => {
    expect(shouldSkipPlaceholderSeason(inherited, true)).toBe(true);
    expect(shouldSkipPlaceholderSeason(own, true)).toBe(false);
    expect(shouldSkipPlaceholderSeason(inherited, false)).toBe(false);
  });

  it('finds placeholder shows by edition or Specials-only seasons', () => {
    const keys = findPlaceholderShowKeys(
      [show('a', 'Trailer'), show('b'), show('c'), show('d')],
      [
        season('sa', 'a', undefined, 0),
        season('sb', 'b', undefined, 0),
        season('sc1', 'c', undefined, 0),
        season('sc2', 'c', undefined, 1),
      ]
    );
    expect([...keys].sort()).toEqual(['a', 'b']);
  });

  it('partitions seasons, keeping own-poster and non-placeholder ones', async () => {
    const real = season('s4', 'show4', '/library/metadata/show4/thumb/1');
    const { kept, skipped } = await partitionPlaceholderSeasons(
      [inherited, own, real],
      (key) => key === 'show1' || key === 'show2'
    );
    expect(skipped).toEqual([inherited]);
    expect(kept).toEqual([own, real]);
  });

  it('resolves the parent show through Plex and fails open on errors', async () => {
    const calls: string[] = [];
    const plexApi = {
      getMetadata: async (key: string) => {
        calls.push(key);
        if (key === 'boom') throw new Error('plex down');
        return { ratingKey: key, type: 'show', editionTitle: 'Trailer' };
      },
    } as never;
    const a = season('x1', 'ph', '/library/metadata/ph/thumb/1');
    const b = season('x2', 'ph', '/library/metadata/ph/thumb/2');
    const c = season('x3', 'boom', '/library/metadata/boom/thumb/1');
    const { kept, skipped } = await partitionPlaceholderSeasons(
      [a, b, c],
      plexPlaceholderShowResolver(plexApi)
    );
    expect(skipped).toEqual([a, b]);
    expect(kept).toEqual([c]);
    expect(calls).toEqual(['ph', 'boom']);
  });

  it('recognises a legacy placeholder show from its children', async () => {
    const plexApi = {
      getMetadata: async (
        key: string,
        options?: { includeChildren?: boolean }
      ) => ({
        ratingKey: key,
        type: 'show',
        leafCount: 1,
        ...(options?.includeChildren && {
          Children: { Metadata: [{ index: 0 }] },
        }),
      }),
    } as never;
    const legacy = season('x4', 'old', '/library/metadata/old/thumb/1');
    const { skipped } = await partitionPlaceholderSeasons(
      [legacy],
      plexPlaceholderShowResolver(plexApi)
    );
    expect(skipped).toEqual([legacy]);
  });
});

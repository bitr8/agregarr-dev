/**
 * Tests for the reorder partitioning helper.
 *
 * The bug this guards: `otherLibrary` was derived from saved settings while the
 * accepted set came straight from the request body, with nothing checking that
 * a payload item belonged to the library named in the request. A cross-library
 * item then matched both groups and the rebuilt array stored it twice under one
 * id, which is how two live collection configs ended up duplicated.
 */

import { describe, expect, it } from 'vitest';

import {
  buildReorderedConfigs,
  findSavedOriginal,
  partitionForReorder,
  resolveConfigLibraryId,
  type ReorderableConfig,
} from './reorderPartition';

interface TestConfig extends ReorderableConfig {
  name: string;
  lastSyncedAt?: string;
  collectionRatingKey?: string;
}

const config = (
  id: string,
  libraryId: string | string[],
  name = `config-${id}`
): TestConfig => ({ id, libraryId, name });

const assembledIds = (
  saved: TestConfig[],
  payload: TestConfig[],
  lib: string
) => {
  const { accepted, otherLibrary, hidden } = partitionForReorder(
    saved,
    payload,
    lib
  );
  return [...otherLibrary, ...accepted, ...hidden].map((c) => c.id);
};

describe('resolveConfigLibraryId', () => {
  it('returns a plain library id unchanged', () => {
    expect(resolveConfigLibraryId('4')).toBe('4');
  });

  it('uses the first entry of a multi-library config', () => {
    expect(resolveConfigLibraryId(['4', '3'])).toBe('4');
  });
});

describe('findSavedOriginal', () => {
  it('never merges from a same-id config in another library', () => {
    // An unscoped find returns the library 4 copy first and leaks its
    // collectionRatingKey into the library 3 config.
    const saved = [
      { ...config('x', '4'), collectionRatingKey: 'RK_MOVIES' },
      { ...config('x', '3'), collectionRatingKey: 'RK_TV' },
    ];

    expect(findSavedOriginal(saved, 'x', '3')?.collectionRatingKey).toBe(
      'RK_TV'
    );
    expect(findSavedOriginal(saved, 'x', '4')?.collectionRatingKey).toBe(
      'RK_MOVIES'
    );
  });

  it('returns undefined for an id the payload introduced', () => {
    expect(findSavedOriginal([config('1', '4')], '99', '4')).toBeUndefined();
  });

  it('returns undefined when the id exists only in another library', () => {
    expect(findSavedOriginal([config('1', '4')], '1', '3')).toBeUndefined();
  });
});

describe('partitionForReorder', () => {
  it('keeps the three groups disjoint for a normal same-library reorder', () => {
    const saved = [config('1', '4'), config('2', '4'), config('3', '3')];
    const payload = [config('2', '4'), config('1', '4')];

    const result = partitionForReorder(saved, payload, '4');

    expect(result.accepted.map((c) => c.id)).toEqual(['2', '1']);
    expect(result.otherLibrary.map((c) => c.id)).toEqual(['3']);
    expect(result.hidden).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it('does not duplicate a config when the payload names another library', () => {
    // Reordering library 3 while the payload carries two library 4 configs.
    const saved = [
      config('10189', '4', 'Slow Cinema'),
      config('10190', '4', 'One Night Films'),
      config('500', '3', 'TV Coming soon'),
    ];
    const payload = [
      config('10189', '4', 'Slow Cinema'),
      config('10190', '4', 'One Night Films'),
    ];

    const result = partitionForReorder(saved, payload, '3');

    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((c) => c.id)).toEqual(['10189', '10190']);
    expect(assembledIds(saved, payload, '3')).toEqual([
      '10189',
      '10190',
      '500',
    ]);
  });

  it('assembles unique ids even when the payload repeats an id', () => {
    const saved = [config('1', '4'), config('2', '4')];
    const payload = [config('1', '4'), config('1', '4'), config('2', '4')];

    const result = partitionForReorder(saved, payload, '4');

    expect(result.accepted.map((c) => c.id)).toEqual(['1', '2']);
    expect(result.rejected.map((c) => c.id)).toEqual(['1']);
    expect(assembledIds(saved, payload, '4')).toEqual(['1', '2']);
  });

  it('keeps library configs the payload did not mention', () => {
    const saved = [config('1', '4'), config('2', '4'), config('3', '4')];
    const payload = [config('2', '4')];

    const result = partitionForReorder(saved, payload, '4');

    expect(result.accepted.map((c) => c.id)).toEqual(['2']);
    expect(result.hidden.map((c) => c.id)).toEqual(['1', '3']);
  });

  it('reports pre-existing duplicate ids without repairing them', () => {
    const stale = { ...config('10189', '4'), lastSyncedAt: '2026-07-04' };
    const fresh = { ...config('10189', '4'), lastSyncedAt: '2026-07-10' };
    const saved = [fresh, stale, config('2', '4')];
    const payload = [config('2', '4')];

    const result = partitionForReorder(saved, payload, '4');

    expect(result.duplicateIds).toEqual(['10189']);
    // Untouched: reordering an unrelated config must not delete either copy.
    expect(assembledIds(saved, payload, '4')).toEqual(['2', '10189', '10189']);
    // And naming the duplicated id must not delete one either.
    // Assembled as [...otherLibrary, ...accepted, ...hidden].
    expect(assembledIds(saved, [config('10189', '4')], '4')).toEqual([
      '10189',
      '10189',
      '2',
    ]);
  });

  it('never drops a duplicate id that lives in another library', () => {
    // Deleting the library 3 copy here would be silent data loss.
    const saved = [
      config('x', '4', 'movies copy'),
      config('x', '3', 'tv copy'),
    ];
    const payload = [config('x', '3', 'tv copy')];

    const result = partitionForReorder(saved, payload, '3');

    expect(result.rejected).toEqual([]);
    expect(result.accepted.map((c) => c.name)).toEqual(['tv copy']);
    expect(result.otherLibrary.map((c) => c.name)).toEqual(['movies copy']);
    expect(assembledIds(saved, payload, '3')).toEqual(['x', 'x']);
  });

  it('never deletes a shadowed same-library duplicate', () => {
    // Two entries, one id, one library. The second is unreachable to every
    // find-by-id consumer, but a reorder is not the place to repair that.
    const saved = [config('x', '4'), config('x', '4')];

    expect(assembledIds(saved, [config('x', '4')], '4')).toEqual(['x', 'x']);
    expect(assembledIds(saved, [], '4')).toEqual(['x', 'x']);
  });

  it('lets a payload introduce an id only once', () => {
    // Two brand-new items sharing an id must not both persist.
    const result = partitionForReorder(
      [],
      [config('n', '4'), config('n', '4')],
      '4'
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(assembledIds([], [config('n', '4'), config('n', '4')], '4')).toEqual(
      ['n']
    );
  });

  it('accepts an id that is not yet saved', () => {
    const saved = [config('1', '4')];
    const payload = [config('1', '4'), config('99', '4', 'brand new')];

    const result = partitionForReorder(saved, payload, '4');

    expect(result.accepted.map((c) => c.id)).toEqual(['1', '99']);
    expect(result.rejected).toEqual([]);
  });

  it('treats a multi-library config as belonging to its first library', () => {
    const saved = [config('1', ['4', '3'])];

    expect(
      partitionForReorder(saved, [config('1', ['4', '3'])], '4').accepted
    ).toHaveLength(1);
    expect(
      partitionForReorder(saved, [config('1', ['4', '3'])], '3').rejected
    ).toHaveLength(1);
  });

  it('preserves a config whose library id cannot be resolved', () => {
    // An empty array resolves to undefined, so it matches no library.
    const saved = [config('1', []), config('2', '4')];
    const payload = [config('2', '4')];

    const result = partitionForReorder(saved, payload, '4');

    expect(result.otherLibrary.map((c) => c.id)).toEqual(['1']);
    expect(result.hidden).toEqual([]);
    expect(assembledIds(saved, payload, '4')).toEqual(['1', '2']);
  });

  it('rejects a payload item whose saved library id cannot be resolved', () => {
    const saved = [config('1', [])];
    const payload = [config('1', [])];

    const result = partitionForReorder(saved, payload, '4');

    expect(result.rejected.map((c) => c.id)).toEqual(['1']);
    expect(assembledIds(saved, payload, '4')).toEqual(['1']);
  });

  it('never introduces a duplicate id that the saved array did not already have', () => {
    const saved = [config('1', '4'), config('2', '3'), config('3', '4')];
    const payload = [config('1', '4'), config('2', '3'), config('3', '4')];

    for (const lib of ['3', '4']) {
      const ids = assembledIds(saved, payload, lib);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('reproduces the live corruption and no longer emits it', () => {
    // Route scoped to library 3, payload carrying two library 4 configs.
    // Before the fix each landed in otherLibrary AND finalConfigs.
    const saved = [
      config('10189', '4', 'Slow Cinema'),
      config('10190', '4', 'One Night Films'),
      config('500', '3', 'TV Coming soon'),
    ];
    const payload = [config('10189', '4'), config('10190', '4')];

    const ids = assembledIds(saved, payload, '3');

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(saved.length);
  });
});

describe('buildReorderedConfigs', () => {
  it('merges an accepted payload item over its own saved original', () => {
    const saved = [{ ...config('1', '4'), collectionRatingKey: 'RK_1' }];
    const accepted = [config('1', '4', 'renamed')];

    const [result] = buildReorderedConfigs(
      saved,
      accepted,
      [],
      '4',
      'sortOrderLibrary'
    );

    expect(result.name).toBe('renamed');
    expect(result.collectionRatingKey).toBe('RK_1');
  });

  it('never leaks a field from the first copy into a shadowed duplicate', () => {
    // The shadowed copy has no collectionRatingKey. Merging it against the
    // first copy would spread RK_FIRST in, because spread cannot unset a key.
    const first = {
      ...config('x', '4', 'first'),
      collectionRatingKey: 'RK_FIRST',
    };
    const shadowed = config('x', '4', 'shadowed');
    const saved = [first, shadowed];
    const { accepted, hidden } = partitionForReorder(
      saved,
      [config('x', '4', 'dragged')],
      '4'
    );

    const result = buildReorderedConfigs(
      saved,
      accepted,
      hidden,
      '4',
      'sortOrderLibrary'
    );

    expect(result).toHaveLength(2);
    expect(result[1].name).toBe('shadowed');
    expect(result[1].collectionRatingKey).toBeUndefined();
  });

  it('falls back to the payload config for a brand-new id', () => {
    const [result] = buildReorderedConfigs(
      [],
      [config('99', '4', 'brand new')],
      [],
      '4',
      'sortOrderLibrary'
    );

    expect(result.name).toBe('brand new');
    expect(result.sortOrderLibrary).toBe(0);
  });

  it("keeps a hidden item's own saved sort order", () => {
    const saved = [
      config('1', '4'),
      { ...config('2', '4'), sortOrderLibrary: 12 },
    ];
    const { accepted, hidden } = partitionForReorder(
      saved,
      [config('1', '4')],
      '4'
    );

    const result = buildReorderedConfigs(
      saved,
      accepted,
      hidden,
      '4',
      'sortOrderLibrary'
    );

    expect(result[1].id).toBe('2');
    expect(result[1].sortOrderLibrary).toBe(12);
  });

  it('keeps an existing sort order and numbers hidden items after accepted', () => {
    const saved = [config('1', '4'), config('2', '4')];
    const { accepted, hidden } = partitionForReorder(
      saved,
      [{ ...config('1', '4'), sortOrderLibrary: 7 }],
      '4'
    );

    const result = buildReorderedConfigs(
      saved,
      accepted,
      hidden,
      '4',
      'sortOrderLibrary'
    );

    expect(result[0].sortOrderLibrary).toBe(7);
    expect(result[1].sortOrderLibrary).toBe(1);
  });
});

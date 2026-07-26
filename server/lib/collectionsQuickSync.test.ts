import type { CollectionMissingItems } from '@server/entity/CollectionMissingItems';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const deleteSpy = vi.fn();
vi.mock('@server/datasource', () => ({
  getRepository: () => ({ delete: deleteSpy }),
}));
vi.mock('@server/entity/CollectionMissingItems', () => ({
  CollectionMissingItems: class {},
}));
vi.mock('@server/entity/ComingSoonItem', () => ({ ComingSoonItem: class {} }));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({ plex: { collectionConfigs: [] } }),
}));

import collectionsQuickSync from './collectionsQuickSync';

// addItemsToCollection is private; the quick sync class isn't exported, so
// the wrapper is reached via the singleton default export instead.
const callAddItemsToCollection = (
  collectionRatingKey: string,
  matches: {
    plexItem: { ratingKey: string; title: string };
    missingItem: Partial<CollectionMissingItems>;
  }[],
  plexClient: { addItemsToCollection: ReturnType<typeof vi.fn> }
) =>
  (
    collectionsQuickSync as unknown as {
      addItemsToCollection: (
        collectionRatingKey: string,
        matches: unknown,
        plexClient: unknown
      ) => Promise<number>;
    }
  ).addItemsToCollection(collectionRatingKey, matches, plexClient);

const match = (id: number, ratingKey: string, position: number) => ({
  plexItem: { ratingKey, title: `Item ${ratingKey}` },
  missingItem: { id, originalPosition: position, configId: 'cfg-1' },
});

describe('collectionsQuickSync.addItemsToCollection - work queue deletion', () => {
  beforeEach(() => {
    deleteSpy.mockClear();
  });

  it('deletes all matched items when the write is fully verified', async () => {
    const matches = [match(1, '10', 0), match(2, '20', 1)];
    const plexClient = {
      addItemsToCollection: vi
        .fn()
        .mockResolvedValue({ successful: 2, failed: 0 }),
    };

    const added = await callAddItemsToCollection('999', matches, plexClient);

    expect(added).toBe(2);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith([1, 2]);
  });

  it('keeps every item in the queue when the add is fully unverified', async () => {
    const matches = [match(1, '10', 0), match(2, '20', 1)];
    const plexClient = {
      addItemsToCollection: vi
        .fn()
        .mockResolvedValue({ successful: 0, failed: 2 }),
    };

    const added = await callAddItemsToCollection('999', matches, plexClient);

    expect(added).toBe(0);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('only deletes the verified count on a partial add, not the full match set', async () => {
    const matches = [match(1, '10', 0), match(2, '20', 1), match(3, '30', 2)];
    const plexClient = {
      addItemsToCollection: vi
        .fn()
        .mockResolvedValue({ successful: 1, failed: 2 }),
    };

    const added = await callAddItemsToCollection('999', matches, plexClient);

    expect(added).toBe(1);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith([1]);
  });
});

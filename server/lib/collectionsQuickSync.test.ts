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
const cfg = vi.hoisted(() => ({ configs: [] as Record<string, unknown>[] }));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({ plex: { collectionConfigs: cfg.configs } }),
}));
const resync = vi.hoisted(() => ({
  processCollections: vi.fn(),
  getFreshCache: vi.fn(async () => ({})),
  lock: [] as string[],
}));
vi.mock('@server/lib/collections/services/LibraryCacheService', () => ({
  libraryCacheService: { getFreshCache: resync.getFreshCache },
}));
vi.mock(
  '@server/lib/collections/services/IndividualCollectionScheduler',
  () => ({
    IndividualCollectionScheduler: {
      waitForApiAccess: async (type: string) => {
        resync.lock.push(`wait:${type}`);
      },
      releaseApiAccess: (type: string) => {
        resync.lock.push(`release:${type}`);
      },
    },
  })
);
vi.mock('@server/lib/collections/services/CollectionSyncService', () => ({
  collectionSyncService: {
    createSyncService: async () => ({
      processCollections: resync.processCollections,
    }),
  },
}));
const full = vi.hoisted(() => ({ status: { running: false, pending: false } }));
vi.mock('@server/lib/collectionsSync', () => ({ default: full }));

import collectionsQuickSync from './collectionsQuickSync';

// addItemsToCollection is private; the quick sync class isn't exported, so
// the wrapper is reached via the singleton default export instead.
const callAddItemsToCollection = (
  collectionRatingKey: string,
  matches: {
    plexItem: { ratingKey: string; title: string };
    missingItem: Partial<CollectionMissingItems>;
  }[],
  plexClient: Record<string, ReturnType<typeof vi.fn>>
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

describe('collectionsQuickSync.runForItem', () => {
  it('targets the item library and returns collection/placeholder counts', async () => {
    const service = collectionsQuickSync as unknown as {
      running: boolean;
      getPlexClient: () => Promise<unknown>;
      cleanupPlaceholdersForRecentItems: (...args: unknown[]) => Promise<{
        deletedCount: number;
        cleanedEntries: unknown[];
      }>;
      processRecentItems: (...args: unknown[]) => Promise<{
        matched: number;
        collectionsUpdated: number;
        itemsAdded: number;
      }>;
      runForItem: (ratingKey: string) => Promise<{
        libraryId: string;
        title: string;
        itemsMatched: number;
        collectionsUpdated: number;
        itemsAdded: number;
        placeholdersDeleted: number;
      }>;
    };
    const getMetadata = vi.fn().mockResolvedValue({
      ratingKey: '42',
      title: 'New Movie',
      type: 'movie',
      librarySectionID: 7,
      guid: 'plex://movie/42',
      Guid: [{ id: 'tmdb://123' }],
      Media: [],
      addedAt: 1,
      updatedAt: 1,
    });

    const client = { getMetadata };
    const getPlexClient = vi
      .spyOn(service, 'getPlexClient')
      .mockResolvedValue(client);
    const cleanup = vi
      .spyOn(service, 'cleanupPlaceholdersForRecentItems')
      .mockResolvedValue({ deletedCount: 1, cleanedEntries: [] });
    const process = vi
      .spyOn(service, 'processRecentItems')
      .mockResolvedValue({ matched: 2, collectionsUpdated: 2, itemsAdded: 2 });

    const result = await service.runForItem('42');

    expect(getMetadata).toHaveBeenCalledWith('42', { includeChildren: true });
    expect(cleanup).toHaveBeenCalledWith(
      [expect.objectContaining({ ratingKey: '42' })],
      '7',
      client
    );
    expect(process).toHaveBeenCalledWith(
      [expect.objectContaining({ ratingKey: '42' })],
      '7',
      client
    );
    expect(result).toEqual({
      libraryId: '7',
      title: 'New Movie',
      itemsMatched: 2,
      collectionsUpdated: 2,
      itemsAdded: 2,
      placeholdersDeleted: 1,
    });
    expect(service.running).toBe(false);

    getPlexClient.mockRestore();
    cleanup.mockRestore();
    process.mockRestore();
  });
});

describe('collectionsQuickSync.addItemsToCollection - existing members and Coming Soon', () => {
  beforeEach(() => {
    deleteSpy.mockClear();
    resync.processCollections.mockReset();
    resync.processCollections.mockImplementation(async () => {
      resync.lock.push('sync');
      return { created: 0, updated: 1 };
    });
    resync.getFreshCache.mockReset();
    resync.getFreshCache.mockImplementation(async () => {
      resync.lock.push('cache');
      return {};
    });
    full.status = { running: false, pending: false };
    resync.lock = [];
    cfg.configs = [];
  });

  const client = (
    members: string[] | Error,
    after: string[] = [],
    added = { successful: 1, failed: 0 }
  ) => ({
    getCollectionItemsOrThrow: vi.fn(async () => {
      if (members instanceof Error) throw members;
      return members;
    }),
    getCollectionItems: vi.fn(async () => after),
    getAllCollections: vi.fn(async () => []),
    addItemsToCollection: vi.fn().mockResolvedValue(added),
  });

  it('does not re-add an item that is already in the collection', async () => {
    const plexClient = client(['10']);
    const added = await callAddItemsToCollection(
      '999',
      [match(1, '10', 1), match(2, '20', 2)],
      plexClient
    );
    expect(plexClient.addItemsToCollection).toHaveBeenCalledWith('999', [
      { ratingKey: '20', title: 'Item 20' },
    ]);
    expect(deleteSpy).toHaveBeenNthCalledWith(1, [1]);
    expect(deleteSpy).toHaveBeenNthCalledWith(2, [2]);
    expect(added).toBe(1);
  });

  it('adds nothing when every match is already a member', async () => {
    const plexClient = client(['10', '20']);
    const added = await callAddItemsToCollection(
      '999',
      [match(1, '10', 1), match(2, '20', 2)],
      plexClient
    );
    expect(added).toBe(0);
    expect(plexClient.addItemsToCollection).not.toHaveBeenCalled();
    expect(deleteSpy).toHaveBeenCalledWith([1, 2]);
  });

  it('adds every match when the member lookup fails', async () => {
    const plexClient = client(new Error('timeout'), [], {
      successful: 2,
      failed: 0,
    });
    const added = await callAddItemsToCollection(
      '999',
      [match(1, '10', 1), match(2, '20', 2)],
      plexClient
    );
    expect(added).toBe(2);
    expect(plexClient.addItemsToCollection).toHaveBeenCalledTimes(1);
  });

  it('re-syncs a Coming Soon collection instead of appending', async () => {
    const config = { id: 'cfg-1', name: 'Anticipated', type: 'comingsoon' };
    cfg.configs = [config];
    const plexClient = client(['10'], ['20', '10']);
    const added = await callAddItemsToCollection(
      '999',
      [match(2, '20', 1), match(3, '30', 5)],
      plexClient
    );
    expect(plexClient.addItemsToCollection).not.toHaveBeenCalled();
    expect(resync.getFreshCache).toHaveBeenCalledTimes(1);
    expect(resync.processCollections).toHaveBeenCalledTimes(1);
    const call = resync.processCollections.mock.calls[0] as unknown[];
    expect(call[0]).toEqual([config]);
    expect(call[5]).toEqual({ reorderOnly: true });
    expect(resync.lock).toEqual([
      'wait:comingsoon',
      'cache',
      'sync',
      'release:comingsoon',
    ]);
    expect(added).toBe(1);
    expect(deleteSpy).toHaveBeenCalledWith([2]);
    expect(deleteSpy).not.toHaveBeenCalledWith(expect.arrayContaining([3]));
  });

  it('releases the lock when the re-sync throws', async () => {
    cfg.configs = [{ id: 'cfg-1', name: 'Anticipated', type: 'comingsoon' }];
    resync.processCollections.mockRejectedValueOnce(new Error('boom'));
    await expect(
      callAddItemsToCollection('999', [match(2, '20', 1)], client([]))
    ).rejects.toThrow('boom');
    expect(resync.lock).toEqual([
      'wait:comingsoon',
      'cache',
      'release:comingsoon',
    ]);
  });

  it('leaves the collection to a full sync that started while it waited', async () => {
    cfg.configs = [{ id: 'cfg-1', name: 'Anticipated', type: 'comingsoon' }];
    full.status = { running: false, pending: true };
    const added = await callAddItemsToCollection(
      '999',
      [match(2, '20', 1)],
      client([])
    );
    expect(added).toBe(0);
    expect(resync.processCollections).not.toHaveBeenCalled();
    expect(resync.lock).toEqual(['wait:comingsoon', 'release:comingsoon']);
  });

  it('checks membership on the rating key the re-sync saved', async () => {
    cfg.configs = [
      {
        id: 'cfg-1',
        name: 'Anticipated',
        type: 'comingsoon',
        collectionRatingKey: 'new',
      },
    ];
    const plexClient = client([], ['20']);
    await callAddItemsToCollection('999', [match(2, '20', 1)], plexClient);
    expect(plexClient.getCollectionItems).toHaveBeenCalledWith('new');
  });

  it('skips the re-sync when the Coming Soon match is already a member', async () => {
    cfg.configs = [{ id: 'cfg-1', name: 'Anticipated', type: 'comingsoon' }];
    const plexClient = client(['20']);
    const added = await callAddItemsToCollection(
      '999',
      [match(2, '20', 1)],
      plexClient
    );
    expect(added).toBe(0);
    expect(resync.processCollections).not.toHaveBeenCalled();
  });

  it('keeps appending for other collection types and multi-source Coming Soon', async () => {
    for (const config of [
      { id: 'cfg-1', name: 'List', type: 'trakt' },
      { id: 'cfg-1', name: 'Mixed', type: 'comingsoon', isMultiSource: true },
    ]) {
      cfg.configs = [config];
      const plexClient = client([]);
      await callAddItemsToCollection('999', [match(2, '20', 1)], plexClient);
      expect(plexClient.addItemsToCollection).toHaveBeenCalledTimes(1);
    }
    expect(resync.processCollections).not.toHaveBeenCalled();
  });
});

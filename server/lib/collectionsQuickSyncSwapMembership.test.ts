import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  records: [] as Record<string, unknown>[],
  update: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('@server/datasource', () => ({
  getRepository: () => ({
    createQueryBuilder: () => {
      const qb = { where: () => qb, getMany: async () => db.records };
      return qb;
    },
    find: async () => db.records,
    update: db.update,
    remove: db.remove,
  }),
}));
vi.mock('@server/entity/CollectionMissingItems', () => ({
  CollectionMissingItems: class {},
}));
vi.mock('@server/entity/ComingSoonItem', () => ({ ComingSoonItem: class {} }));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const cfg = vi.hoisted(() => ({
  configs: [] as Record<string, unknown>[],
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    plex: {
      libraries: [{ key: '1', type: 'movie' }],
      collectionConfigs: cfg.configs,
    },
  }),
}));
const removePlaceholder = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@server/lib/placeholders/placeholderManager', () => ({
  removePlaceholder,
  resolveRecordPath: (root: string, p: string) => `${root}/${p}`,
}));
const root = vi.hoisted(() => ({ value: '/lib' as string | undefined }));
vi.mock('@server/lib/placeholders/services/PlaceholderCleanup', () => ({
  rootOf: () => root.value,
  cleanupPlaceholderRemnants: vi.fn(),
}));
vi.mock('@server/lib/placeholders/services/PlaceholderContextService', () => ({
  placeholderContextService: { isPlaceholderItem: () => false },
}));
vi.mock('@server/lib/collections/services/LibraryCacheService', () => ({
  libraryCacheService: {},
}));
vi.mock(
  '@server/lib/collections/services/IndividualCollectionScheduler',
  () => ({ IndividualCollectionScheduler: {} })
);
vi.mock('@server/lib/collections/services/CollectionSyncService', () => ({
  collectionSyncService: {},
}));
vi.mock('@server/lib/collectionsSync', () => ({ default: {} }));

import collectionsQuickSync from './collectionsQuickSync';

const plex = {
  removeLabelFromItem: vi.fn(),
  getCollectionItemsOrThrow: vi.fn(),
  addItemsToCollection: vi.fn(),
};

const cleanup = () =>
  (
    collectionsQuickSync as unknown as {
      cleanupPlaceholdersForRecentItems: (
        items: unknown[],
        libraryId: string,
        plexClient: unknown
      ) => Promise<{
        deletedCount: number;
        itemsAdded: number;
        collectionsUpdated: number;
      }>;
    }
  ).cleanupPlaceholdersForRecentItems(
    [
      {
        ratingKey: 'real-1',
        title: 'Film',
        type: 'movie',
        Guid: [{ id: 'tmdb://42' }],
      },
    ],
    '1',
    plex
  );

const config = (over: Record<string, unknown> = {}) => ({
  id: 'cfg-1',
  name: 'List',
  libraryId: '1',
  type: 'mdblist',
  createPlaceholdersForMissing: true,
  collectionRatingKey: 'col-1',
  ...over,
});

const record = (over: Record<string, unknown> = {}) => ({
  id: 1,
  tmdbId: 42,
  mediaType: 'movie',
  configId: 'cfg-1',
  placeholderPath: 'Film (2026)/x.mkv',
  plexRatingKey: 'ph-1',
  ...over,
});

describe('quick sync swap keeps collection membership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    root.value = '/lib';
    cfg.configs = [config()];
    db.records = [record()];
    plex.getCollectionItemsOrThrow.mockResolvedValue(['ph-1', 'other']);
    plex.addItemsToCollection.mockResolvedValue({ successful: 1, failed: 0 });
  });

  it('adds the real movie to a collection holding the placeholder, and still cleans up', async () => {
    const res = await cleanup();
    expect(plex.addItemsToCollection).toHaveBeenCalledWith('col-1', [
      { ratingKey: 'real-1', title: 'Film' },
    ]);
    expect(res.itemsAdded).toBe(1);
    expect(res.collectionsUpdated).toBe(1);
    expect(removePlaceholder).toHaveBeenCalledTimes(1);
    expect(db.remove).toHaveBeenCalled();
    expect(res.deletedCount).toBe(1);
  });

  it('does not add when the real movie is already a member', async () => {
    plex.getCollectionItemsOrThrow.mockResolvedValue(['ph-1', 'real-1']);
    const res = await cleanup();
    expect(plex.addItemsToCollection).not.toHaveBeenCalled();
    expect(res.itemsAdded).toBe(0);
  });

  it('does not add when the placeholder was not a member', async () => {
    plex.getCollectionItemsOrThrow.mockResolvedValue(['other']);
    await cleanup();
    expect(plex.addItemsToCollection).not.toHaveBeenCalled();
  });

  it('leaves Coming Soon collections to their own sync', async () => {
    cfg.configs = [config({ type: 'comingsoon' })];
    await cleanup();
    expect(plex.addItemsToCollection).not.toHaveBeenCalled();
  });

  it('skips a collection it cannot read and still cleans up', async () => {
    plex.getCollectionItemsOrThrow.mockRejectedValue(new Error('boom'));
    const res = await cleanup();
    expect(plex.addItemsToCollection).not.toHaveBeenCalled();
    expect(removePlaceholder).toHaveBeenCalledTimes(1);
    expect(res.deletedCount).toBe(1);
  });

  it('resolves a multi-source config id to its base config', async () => {
    db.records = [record({ configId: 'cfg-1-source-2' })];
    await cleanup();
    expect(plex.addItemsToCollection).toHaveBeenCalledTimes(1);
  });

  it('covers every collection of a multi-collection config', async () => {
    cfg.configs = [
      config({
        collectionRatingKey: undefined,
        collectionRatingKeys: ['a', 'b'],
      }),
    ];
    await cleanup();
    expect(plex.addItemsToCollection).toHaveBeenCalledTimes(2);
  });

  it('falls back to the single collection key when the key list is empty', async () => {
    cfg.configs = [config({ collectionRatingKeys: [] })];
    await cleanup();
    expect(plex.addItemsToCollection).toHaveBeenCalledWith('col-1', [
      { ratingKey: 'real-1', title: 'Film' },
    ]);
  });

  it('ignores a config on another library', async () => {
    cfg.configs = [
      config({ id: 'cfg-1', collectionRatingKey: 'col-1' }),
      config({ id: 'cfg-x', libraryId: '2', collectionRatingKey: 'col-x' }),
    ];
    db.records = [
      record({ id: 1, configId: 'cfg-1', plexRatingKey: 'ph-1' }),
      record({ id: 2, configId: 'cfg-x', plexRatingKey: 'ph-x' }),
    ];
    plex.getCollectionItemsOrThrow.mockResolvedValue(['ph-1', 'ph-x']);
    await cleanup();
    expect(plex.addItemsToCollection).toHaveBeenCalledTimes(1);
    expect(plex.addItemsToCollection.mock.calls[0][0]).toBe('col-1');
  });

  it('only counts the placeholder key owned by that config', async () => {
    cfg.configs = [
      config({ id: 'cfg-a', collectionRatingKey: 'col-a' }),
      config({ id: 'cfg-b', collectionRatingKey: 'col-b' }),
    ];
    db.records = [
      record({ id: 1, configId: 'cfg-a', plexRatingKey: 'ph-a' }),
      record({ id: 2, configId: 'cfg-b', plexRatingKey: 'ph-b' }),
    ];
    plex.getCollectionItemsOrThrow.mockImplementation(async (k: string) =>
      k === 'col-a' ? ['ph-a'] : ['ph-a']
    );
    await cleanup();
    expect(plex.addItemsToCollection).toHaveBeenCalledTimes(1);
    expect(plex.addItemsToCollection.mock.calls[0][0]).toBe('col-a');
  });

  it('does not add a collection-excluded real item', async () => {
    const spy = vi
      .spyOn(
        collectionsQuickSync as unknown as Record<string, () => unknown>,
        'resolveCollectionExcludedKeys'
      )
      .mockResolvedValue(new Set(['real-1']) as never);
    await cleanup();
    spy.mockRestore();
    expect(plex.addItemsToCollection).not.toHaveBeenCalled();
  });

  it('does not add a label-excluded real item', async () => {
    const spy = vi
      .spyOn(
        collectionsQuickSync as unknown as Record<string, () => unknown>,
        'resolveLabelExcludedKeys'
      )
      .mockResolvedValue(new Set(['real-1']) as never);
    await cleanup();
    spy.mockRestore();
    expect(plex.addItemsToCollection).not.toHaveBeenCalled();
  });

  it('never touches a smart (unwatched-only) collection', async () => {
    cfg.configs = [config({ showUnwatchedOnly: true })];
    await cleanup();
    expect(plex.getCollectionItemsOrThrow).not.toHaveBeenCalled();
    expect(plex.addItemsToCollection).not.toHaveBeenCalled();
  });

  it('adds nothing when the file deletion is refused', async () => {
    removePlaceholder.mockRejectedValueOnce(
      Object.assign(new Error('nope'), { code: 'EOWNERSHIP' })
    );
    const res = await cleanup();
    expect(plex.addItemsToCollection).not.toHaveBeenCalled();
    expect(res.deletedCount).toBe(0);
  });

  it('adds nothing when the library root is missing', async () => {
    root.value = undefined;
    await cleanup();
    expect(plex.addItemsToCollection).not.toHaveBeenCalled();
  });

  it('still cleans up when the add itself fails', async () => {
    plex.addItemsToCollection.mockRejectedValue(new Error('plex down'));
    const res = await cleanup();
    expect(res.deletedCount).toBe(1);
    expect(res.itemsAdded).toBe(0);
  });
});

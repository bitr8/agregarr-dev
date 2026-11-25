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
  libType: 'show' as 'show' | 'movie',
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    plex: {
      libraries: [{ key: '1', type: cfg.libType }],
      collectionConfigs: [
        { id: 'cfg-1', libraryId: '1', createPlaceholdersForMissing: true },
      ],
    },
  }),
}));
const removePlaceholder = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@server/lib/placeholders/placeholderManager', () => ({
  removePlaceholder,
  resolveRecordPath: (root: string, p: string) => `${root}/${p}`,
}));
vi.mock('@server/lib/placeholders/services/PlaceholderCleanup', () => ({
  rootOf: () => '/lib',
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

const cleanup = (items: unknown[]) =>
  (
    collectionsQuickSync as unknown as {
      cleanupPlaceholdersForRecentItems: (
        items: unknown[],
        libraryId: string,
        plexClient: unknown
      ) => Promise<{ deletedCount: number }>;
    }
  ).cleanupPlaceholdersForRecentItems(items, '1', {
    removeLabelFromItem: vi.fn(),
  });

const realShow = {
  ratingKey: '500',
  title: 'Show',
  type: 'show',
  Guid: [{ id: 'tmdb://42' }],
};

describe('quick sync placeholder cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfg.libType = 'show';
  });

  it('leaves a TV edition placeholder for the full-sync hand-over', async () => {
    db.records = [
      {
        id: 7,
        tmdbId: 42,
        mediaType: 'tv',
        configId: 'cfg-1',
        placeholderPath: 'Show (2026) {edition-Trailer}/x.mkv',
      },
    ];
    const res = await cleanup([realShow]);
    expect(db.update).not.toHaveBeenCalled();
    expect(removePlaceholder).not.toHaveBeenCalled();
    expect(db.remove).not.toHaveBeenCalled();
    expect(res.deletedCount).toBe(0);
  });

  it('leaves a TV edition placeholder alone when the real show has its own edition', async () => {
    db.records = [
      {
        id: 7,
        tmdbId: 42,
        mediaType: 'tv',
        configId: 'cfg-1',
        placeholderPath: 'Show (2026) {edition-Trailer}/x.mkv',
      },
    ];
    const res = await cleanup([{ ...realShow, editionTitle: 'Extended' }]);
    expect(db.update).not.toHaveBeenCalled();
    expect(removePlaceholder).not.toHaveBeenCalled();
    expect(res.deletedCount).toBe(0);
  });

  it('still deletes a non-edition TV placeholder immediately', async () => {
    db.records = [
      {
        id: 8,
        tmdbId: 42,
        mediaType: 'tv',
        configId: 'cfg-1',
        placeholderPath: 'Show (2026)/x.mkv',
      },
    ];
    const res = await cleanup([realShow]);
    expect(db.update).not.toHaveBeenCalled();
    expect(removePlaceholder).toHaveBeenCalledTimes(1);
    expect(res.deletedCount).toBe(1);
  });

  it('movie quick sync deletion is unchanged, even for an edition path', async () => {
    cfg.libType = 'movie';
    db.records = [
      {
        id: 9,
        tmdbId: 42,
        mediaType: 'movie',
        configId: 'cfg-1',
        placeholderPath: 'Film (2026) {edition-Trailer}/x.mkv',
      },
    ];
    const res = await cleanup([{ ...realShow, type: 'movie' }]);
    expect(db.update).not.toHaveBeenCalled();
    expect(removePlaceholder).toHaveBeenCalledTimes(1);
    expect(db.remove).toHaveBeenCalledWith(db.records);
    expect(res.deletedCount).toBe(1);
  });
});

import type PlexAPI from '@server/api/plexapi';
import type {
  PlexCollection,
  TmdbFranchiseSourceData,
} from '@server/lib/collections/core/types';
import { syncCacheService } from '@server/lib/collections/services/SyncCacheService';
import type { CollectionConfig } from '@server/lib/settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cleanupMock } = vi.hoisted(() => ({
  cleanupMock: vi.fn(async () => undefined),
}));

vi.mock('@server/entity/CollectionMetadata', () => ({
  CollectionMetadata: class {},
}));
vi.mock('@server/entity/PosterTemplate', () => ({ PosterTemplate: class {} }));
vi.mock('@server/entity/User', () => ({ User: class {} }));
vi.mock('@server/api/imdbRatings', () => ({ default: class {} }));
vi.mock('@server/lib/cache', () => ({
  default: { getCache: vi.fn(() => ({ data: {} })) },
}));
vi.mock('@server/lib/posterStorage', () => ({ generatePoster: vi.fn() }));
vi.mock('@server/lib/collections/services/ServiceUserManager', () => ({
  serviceUserManager: {},
}));
vi.mock('@server/lib/collections/utils/TemplateEngine', () => ({
  templateEngine: {
    createFranchiseContext: vi.fn((franchiseData: TmdbFranchiseSourceData) => ({
      franchiseName: franchiseData.franchiseName,
    })),
    processTemplate: vi.fn(
      async (_template: string, context: { franchiseName: string }) =>
        context.franchiseName
    ),
  },
}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({ plex: { collectionConfigs: [] }, save: vi.fn() }),
  getTmdbLanguage: vi.fn(async () => 'en'),
}));
vi.mock('@server/lib/placeholders/services/PlaceholderCleanup', () => ({
  handlePlaceholderCleanup: cleanupMock,
}));

import { TmdbCollectionSync } from './tmdb';

const cfg = (extra: Partial<CollectionConfig> = {}): CollectionConfig =>
  ({
    id: 'cfg-1',
    name: 'Auto Franchises',
    type: 'tmdb',
    subtype: 'auto_franchise',
    libraryId: '4',
    isActive: true,
    ...extra,
  } as CollectionConfig);

const franchise = (
  franchiseId: number,
  tmdbIds: number[]
): TmdbFranchiseSourceData => ({
  franchiseId,
  franchiseName: `Franchise ${franchiseId}`,
  movies: tmdbIds.map((tmdbId) => ({ tmdbId, title: `Movie ${tmdbId}` })),
});

const labelled = (
  ratingKey: string,
  configId: string,
  franchiseId: number,
  libraryKey = '4'
): PlexCollection =>
  ({
    ratingKey,
    title: `Franchise ${franchiseId}`,
    type: 'collection',
    libraryKey,
    labels: [`AgregarrAutoFranchise-${configId}-${franchiseId}`],
  } as unknown as PlexCollection);

const CACHE = { '4': [] } as any;

// A negative id stands for an item Plex has not matched to TMDB yet
const libraryItem = (tmdbId: number) => ({
  ratingKey: `rk-${tmdbId}`,
  title: `Movie ${tmdbId}`,
  Guid: tmdbId > 0 ? [{ id: `tmdb://${tmdbId}` }] : [],
});

// owned: tmdbIds in the library list discovery sees (ratingKey = `rk-${tmdbId}`).
// live: what a fresh Plex read returns (defaults to owned).
const wire = (
  sync: TmdbCollectionSync,
  franchises: TmdbFranchiseSourceData[],
  owned: number[],
  opts: {
    failedCount?: number;
    emptyLookupFor?: number;
    lookupOwned?: number[];
    live?: number[] | Error;
    liveAfterFirstPage?: number[];
    liveAfterCall?: { call: number; live: number[] };
    totalSizes?: number[];
  } = {}
) => {
  vi.spyOn(sync as any, 'getLibraryMovies').mockResolvedValue(
    owned.map((tmdbId) => ({
      ratingKey: `rk-${tmdbId}`,
      title: `Movie ${tmdbId}`,
      type: 'movie',
      tmdbId,
    }))
  );
  vi.spyOn(sync as any, 'discoverFranchises').mockResolvedValue({
    franchiseMap: new Map(franchises.map((f) => [f.franchiseId, f])),
    failedCount: opts.failedCount ?? 0,
  });
  vi.spyOn(sync as any, 'findPlexItemsForFranchise').mockImplementation(((
    data: TmdbFranchiseSourceData
  ) =>
    Promise.resolve(
      data.franchiseId === opts.emptyLookupFor
        ? []
        : data.movies
            .filter((m) => (opts.lookupOwned ?? owned).includes(m.tmdbId))
            .map((m) => ({
              ratingKey: `rk-${m.tmdbId}`,
              title: m.title,
              type: 'movie' as const,
              tmdbId: m.tmdbId,
            }))
    )) as any);
  const write = vi
    .spyOn(sync, 'createOrUpdateCollectionStandardized')
    .mockResolvedValue({ created: 1, updated: 0 } as any);
  const processMissing = vi
    .spyOn(sync as any, 'processMissingItems')
    .mockResolvedValue([]);

  const live = opts.live ?? owned;
  let call = 0;
  const getLibraryContents = vi.fn(
    async (_id: string, { offset = 0, size = 50 } = {}) => {
      if (live instanceof Error) throw live;
      const current =
        opts.liveAfterCall && call >= opts.liveAfterCall.call
          ? opts.liveAfterCall.live
          : call > 0 && opts.liveAfterFirstPage
          ? opts.liveAfterFirstPage
          : live;
      const items = current.slice(offset, offset + size).map(libraryItem);
      const totalSize = opts.totalSizes?.[call] ?? current.length;
      call++;
      return { totalSize, items };
    }
  );
  const deleteCollection = vi.fn(async () => undefined);
  const plexClient = {
    deleteCollection,
    getLibraryContents,
  } as unknown as PlexAPI;

  return {
    write,
    processMissing,
    plexClient,
    deleteCollection,
    getLibraryContents,
  };
};

const run = (
  sync: TmdbCollectionSync,
  config: CollectionConfig,
  plexClient: PlexAPI,
  collections: PlexCollection[] = [],
  libraryCache: 'none' | typeof CACHE = CACHE
) =>
  (sync as any).processFranchiseCollections(
    config,
    plexClient,
    collections,
    undefined,
    libraryCache === 'none' ? undefined : libraryCache
  );

const cleanupSet = (): number[] =>
  [...((cleanupMock.mock.calls[0] as unknown[])[3] as Set<number>)].sort(
    (a, b) => a - b
  );

describe('fork#183: franchiseMinimumItems', () => {
  beforeEach(() => {
    syncCacheService.clear();
    cleanupMock.mockClear();
  });

  it('unset minimum keeps the default of 2', async () => {
    const sync = new TmdbCollectionSync();
    const { processMissing, plexClient, deleteCollection } = wire(
      sync,
      [franchise(1, [10, 11, 12]), franchise(2, [20, 21, 22])],
      [10, 20, 21]
    );

    const result = await run(sync, cfg(), plexClient);

    expect(result).toEqual({ created: 1, updated: 0 });
    expect(processMissing).toHaveBeenCalledTimes(1);
    expect(deleteCollection).not.toHaveBeenCalled();
  });

  it('minimum 1 creates a collection for a one-owned franchise and runs missing-item processing', async () => {
    const sync = new TmdbCollectionSync();
    const { processMissing, plexClient, getLibraryContents } = wire(
      sync,
      [franchise(1, [10, 11, 12])],
      [10]
    );

    const result = await run(
      sync,
      cfg({ franchiseMinimumItems: 1 }),
      plexClient
    );

    expect(result).toEqual({ created: 1, updated: 0 });
    const missing = processMissing.mock.calls[0][0] as { tmdbId: number }[];
    expect(missing.map((m) => m.tmdbId)).toEqual([11, 12]);
    // Nothing below the minimum, so no extra library read
    expect(getLibraryContents).not.toHaveBeenCalled();
  });

  it('minimum 3 skips a 2-owned franchise, deletes its collection and drops it from placeholder membership', async () => {
    const sync = new TmdbCollectionSync();
    const { processMissing, plexClient, deleteCollection } = wire(
      sync,
      [franchise(1, [10, 11, 12]), franchise(2, [20, 21, 22])],
      [10, 11, 20, 21, 22]
    );

    const result = await run(
      sync,
      cfg({ franchiseMinimumItems: 3 }),
      plexClient,
      [labelled('900', 'cfg-1', 1)]
    );

    expect(deleteCollection).toHaveBeenCalledTimes(1);
    expect(deleteCollection).toHaveBeenCalledWith('900');
    expect(processMissing).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ created: 1, updated: 0, mutated: true });
    expect(cleanupSet()).toEqual([20, 21, 22]);
  });

  it('removes collections even when no franchise qualifies', async () => {
    const sync = new TmdbCollectionSync();
    const { plexClient, deleteCollection } = wire(
      sync,
      [franchise(1, [10, 11, 12])],
      [10, 11]
    );

    const result = await run(
      sync,
      cfg({ franchiseMinimumItems: 3 }),
      plexClient,
      [labelled('900', 'cfg-1', 1)]
    );

    expect(deleteCollection).toHaveBeenCalledWith('900');
    expect(result).toEqual({ created: 0, updated: 0, mutated: true });
  });

  it('discovery failures (failedCount > 0) delete nothing', async () => {
    const sync = new TmdbCollectionSync();
    const { plexClient, deleteCollection } = wire(
      sync,
      [franchise(1, [10, 11, 12])],
      [10],
      { failedCount: 1 }
    );

    await run(sync, cfg(), plexClient, [labelled('900', 'cfg-1', 1)]);

    expect(deleteCollection).not.toHaveBeenCalled();
  });

  it('a library swap that keeps the count still keeps the collection (fresh read decides)', async () => {
    const sync = new TmdbCollectionSync();
    const { write, plexClient, deleteCollection } = wire(
      sync,
      [franchise(1, [10, 11])],
      [10, 99, 20, 21],
      { live: [10, 11, 20, 21], lookupOwned: [10, 11, 20, 21] }
    );

    const result = await run(sync, cfg(), plexClient, [
      labelled('900', 'cfg-1', 1),
    ]);

    expect(deleteCollection).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(1);
    expect(cleanupSet()).toEqual([10, 11]);
  });

  it('a failed fresh library read removes nothing and keeps membership whole', async () => {
    const sync = new TmdbCollectionSync();
    const { plexClient, deleteCollection } = wire(
      sync,
      [franchise(1, [10, 11, 12]), franchise(2, [20, 21])],
      [10, 20, 21],
      { live: new Error('plex down') }
    );

    await run(sync, cfg(), plexClient, [labelled('900', 'cfg-1', 1)]);

    expect(deleteCollection).not.toHaveBeenCalled();
    expect(cleanupSet()).toEqual([10, 11, 12, 20, 21]);
  });

  it('a library that changes size between pages removes nothing', async () => {
    const big = Array.from({ length: 600 }, (_, i) => 1000 + i);
    const sync = new TmdbCollectionSync();
    const { plexClient, deleteCollection, getLibraryContents } = wire(
      sync,
      [franchise(1, [10, 11, 12])],
      [10, ...big],
      { totalSizes: [601, 602] }
    );

    await run(sync, cfg(), plexClient, [labelled('900', 'cfg-1', 1)]);

    expect(getLibraryContents).toHaveBeenCalledTimes(2);
    expect(deleteCollection).not.toHaveBeenCalled();
  });

  it('reads every page before deciding', async () => {
    const big = Array.from({ length: 600 }, (_, i) => 1000 + i);
    const sync = new TmdbCollectionSync();
    const { plexClient, deleteCollection, getLibraryContents } = wire(
      sync,
      [franchise(1, [10, 11, 12])],
      [...big, 10],
      { live: [...big, 10, 11] }
    );

    await run(sync, cfg(), plexClient, [labelled('900', 'cfg-1', 1)]);

    // Two pages, read twice
    expect(getLibraryContents).toHaveBeenCalledTimes(4);
    expect(deleteCollection).not.toHaveBeenCalled();
  });

  it('without the cache a franchise found in full by the Plex lookup still syncs', async () => {
    const sync = new TmdbCollectionSync();
    const { write, processMissing, plexClient, deleteCollection } = wire(
      sync,
      [franchise(1, [10, 11, 12])],
      [10],
      { lookupOwned: [10, 11], live: [10, 11] }
    );

    const result = await run(sync, cfg(), plexClient, [], 'none');

    expect(write).toHaveBeenCalledTimes(1);
    expect(processMissing).toHaveBeenCalledTimes(1);
    expect(deleteCollection).not.toHaveBeenCalled();
    expect(result.created).toBe(1);
  });

  it('a Plex lookup that comes back empty neither syncs nor deletes the franchise', async () => {
    const sync = new TmdbCollectionSync();
    const { write, plexClient, deleteCollection } = wire(
      sync,
      [franchise(1, [10, 11, 12]), franchise(2, [20, 21])],
      [10, 11, 20, 21],
      { emptyLookupFor: 1 }
    );

    const result = await run(sync, cfg(), plexClient, [
      labelled('900', 'cfg-1', 1),
    ]);

    expect(deleteCollection).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(1);
  });

  it('never deletes collections of another config id or another library', async () => {
    const sync = new TmdbCollectionSync();
    const { plexClient, deleteCollection } = wire(
      sync,
      [franchise(1, [10, 11, 12])],
      [10]
    );

    await run(sync, cfg(), plexClient, [
      labelled('901', 'cfg-2', 1),
      labelled('902', 'cfg-1', 1, '7'),
      labelled('903', 'cfg-1', 1),
    ]);

    expect(deleteCollection).toHaveBeenCalledTimes(1);
    expect(deleteCollection).toHaveBeenCalledWith('903');
  });

  it('a franchise that was never discovered keeps its collection', async () => {
    const sync = new TmdbCollectionSync();
    const { plexClient, deleteCollection } = wire(
      sync,
      [franchise(2, [20, 21])],
      [20, 21]
    );

    await run(sync, cfg(), plexClient, [labelled('900', 'cfg-1', 1)]);

    expect(deleteCollection).not.toHaveBeenCalled();
  });

  it('keeps discovery order when a franchise falls back to the Plex lookup', async () => {
    const sync = new TmdbCollectionSync();
    const { write, plexClient } = wire(
      sync,
      [franchise(1, [10, 11]), franchise(2, [20, 21])],
      [10, 20, 21],
      { live: new Error('plex down'), lookupOwned: [10, 11, 20, 21] }
    );

    await run(sync, cfg(), plexClient);

    const order = (
      (sync as any).findPlexItemsForFranchise.mock.calls as [
        TmdbFranchiseSourceData
      ][]
    ).map(([data]) => data.franchiseId);
    expect(order).toEqual([1, 2]);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('a franchise left to the Plex lookup is skipped when the lookup finds fewer than the minimum', async () => {
    const sync = new TmdbCollectionSync();
    const { write, processMissing, plexClient, deleteCollection } = wire(
      sync,
      [franchise(1, [10, 11, 12])],
      [10],
      { live: new Error('plex down') }
    );

    const result = await run(sync, cfg(), plexClient, [
      labelled('900', 'cfg-1', 1),
    ]);

    expect(write).not.toHaveBeenCalled();
    expect(processMissing).not.toHaveBeenCalled();
    expect(deleteCollection).not.toHaveBeenCalled();
    expect(result).toEqual({ created: 0, updated: 0 });
  });

  it('an item Plex has not matched to TMDB blocks removal', async () => {
    const sync = new TmdbCollectionSync();
    const { plexClient, deleteCollection } = wire(
      sync,
      [franchise(1, [10, 11, 12])],
      [10],
      { live: [10, -1] }
    );

    await run(sync, cfg(), plexClient, [labelled('900', 'cfg-1', 1)]);

    expect(deleteCollection).not.toHaveBeenCalled();
  });

  it('a library that shifts between pages blocks removal', async () => {
    const b = Array.from({ length: 600 }, (_, i) => 1000 + i);
    // Page 1 ends on b[498]; 11 sits at index 500. Removing b[0] and adding 2000
    // keeps the total but slides 11 to index 499, which page 2 would skip.
    const before = [10, ...b.slice(0, 499), 11, ...b.slice(499, 599)];
    const after = [10, ...b.slice(1, 499), 11, ...b.slice(499, 599), 2000];
    const sync = new TmdbCollectionSync();
    const { plexClient, deleteCollection, getLibraryContents } = wire(
      sync,
      [franchise(1, [10, 11, 12])],
      [10],
      { live: before, liveAfterFirstPage: after }
    );

    await run(sync, cfg(), plexClient, [labelled('900', 'cfg-1', 1)]);

    expect(before).toHaveLength(after.length);
    expect(getLibraryContents).toHaveBeenNthCalledWith(2, '4', {
      offset: 499,
      size: 501,
    });
    expect(deleteCollection).not.toHaveBeenCalled();
  });

  it('a change that lands inside an already-read page blocks removal', async () => {
    const b = Array.from({ length: 600 }, (_, i) => 1000 + i);
    // Second page request onward: b[5] gone and 11 added before the boundary,
    // so the total and the boundary item both hold steady.
    const before = [10, ...b];
    const after = [10, ...b.slice(0, 5), 11, ...b.slice(6)];
    const sync = new TmdbCollectionSync();
    const { plexClient, deleteCollection } = wire(
      sync,
      [franchise(1, [10, 11, 12])],
      [10],
      { live: before, liveAfterCall: { call: 1, live: after } }
    );

    await run(sync, cfg(), plexClient, [labelled('900', 'cfg-1', 1)]);

    expect(before).toHaveLength(after.length);
    expect(after[499]).toBe(before[499]);
    expect(deleteCollection).not.toHaveBeenCalled();
  });
});

import type PlexAPI from '@server/api/plexapi';
import type {
  CollectionItem,
  TmdbFranchiseSourceData,
} from '@server/lib/collections/core/types';
import { syncCacheService } from '@server/lib/collections/services/SyncCacheService';
import type { CollectionConfig } from '@server/lib/settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// fork#96: Auto Franchise (one config -> many franchise collections) called the
// single-collection placeholder helper once per franchise, sharing one configId.
// Each call's membership set covered only that franchise's own movies, so franchise
// B's cleanup pass saw franchise A's still-valid placeholders as orphaned and deleted
// them (round 1 red evidence archived in the fork#96 card).
//
// Round 2 rework: cleanup now runs ONCE per config sync (MultiSourceOrchestrator
// shape) instead of once per franchise, and orphan cleanup (not creation) is skipped
// entirely when TMDB discovery only partially completed (discoverFranchises absorbs
// per-movie/per-collection failures - including a null or empty-parts collection
// response - and can return a franchiseMap missing whole franchises).
//
// Round 2 review finding: mocking discoverFranchises only proves cleanup honours a
// supplied counter, not that production discovery reliably supplies one. The
// failedCount contract must be pinned against the REAL discoverFranchises -
// properties 4a-4d below drive it through TMDB-client-level mocks
// (tmdbClient.getMovie / getCollection) instead.

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
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

// Fake handlePlaceholderCleanup that models the real orphan check
// (PlaceholderCleanup.ts: loads every placeholder for the configId, deletes any
// whose tmdbId isn't in the passed-in sourceTmdbIds).
const { handlePlaceholderCleanupMock, placeholderStore } = vi.hoisted(() => {
  const store = new Map<string, Map<number, { title: string }>>();
  const mock = vi.fn(
    async (
      config: { id: string },
      _plexClient: unknown,
      _libraryCache: unknown,
      sourceTmdbIds: Set<number>
    ) => {
      const configStore = store.get(config.id);
      if (!configStore) return;
      for (const tmdbId of [...configStore.keys()]) {
        if (!sourceTmdbIds.has(tmdbId)) {
          configStore.delete(tmdbId);
        }
      }
    }
  );
  return { handlePlaceholderCleanupMock: mock, placeholderStore: store };
});

vi.mock('@server/lib/placeholders/services/PlaceholderCleanup', () => ({
  handlePlaceholderCleanup: handlePlaceholderCleanupMock,
}));

import { TmdbCollectionSync } from './tmdb';

const config = (): CollectionConfig =>
  ({
    id: 'cfg-1',
    name: 'Auto Franchises',
    type: 'tmdb',
    subtype: 'auto_franchise',
    libraryId: '4',
    isActive: true,
  } as CollectionConfig);

const franchise = (
  franchiseId: number,
  name: string,
  tmdbIds: number[]
): TmdbFranchiseSourceData => ({
  franchiseId,
  franchiseName: name,
  movies: tmdbIds.map((tmdbId) => ({ tmdbId, title: `${name} #${tmdbId}` })),
});

// Every franchise movie is already present in Plex - keeps Phase 2 (placeholder
// creation) empty on every call, isolating the assertions to the cleanup call(s).
const wireFranchises = (
  sync: TmdbCollectionSync,
  franchises: [number, TmdbFranchiseSourceData][],
  libraryMovies: CollectionItem[],
  opts: { failForFranchiseId?: number; discoveryFailedCount?: number } = {}
) => {
  const { failForFranchiseId, discoveryFailedCount = 0 } = opts;
  vi.spyOn(sync as any, 'getLibraryMovies').mockResolvedValue(libraryMovies);
  vi.spyOn(sync as any, 'discoverFranchises').mockResolvedValue({
    franchiseMap: new Map(franchises),
    failedCount: discoveryFailedCount,
  });
  vi.spyOn(sync as any, 'findPlexItemsForFranchise').mockImplementation(((
    franchiseData: TmdbFranchiseSourceData
  ) => {
    if (franchiseData.franchiseId === failForFranchiseId) {
      return Promise.reject(
        new Error(`Plex lookup failed for ${franchiseData.franchiseName}`)
      );
    }
    return Promise.resolve(
      franchiseData.movies.map((movie, index) => ({
        ratingKey: `${franchiseData.franchiseId}-${index}`,
        title: movie.title,
        type: 'movie' as const,
        tmdbId: movie.tmdbId,
      }))
    );
  }) as any);
  vi.spyOn(sync, 'createOrUpdateCollectionStandardized').mockResolvedValue({
    created: 1,
    updated: 0,
  } as any);
};

// Drives the REAL discoverFranchises (no mock on the method itself) by stubbing only
// the TMDB-client boundary it calls - this is what pins the failedCount contract,
// rather than merely proving cleanup honours a supplied counter without proving
// production discovery reliably supplies one.
const wireRealDiscovery = (
  sync: TmdbCollectionSync,
  libraryTmdbIds: number[],
  tmdb: {
    movies: Record<number, { collectionId?: number } | 'reject'>;
    collections: Record<
      number,
      | { id: number | string; title?: string; release_date?: string }[]
      | null
      | 'reject'
    >;
  }
) => {
  vi.spyOn(sync as any, 'getLibraryMovies').mockResolvedValue(
    libraryTmdbIds.map((tmdbId, index) => ({
      ratingKey: `lib-${index}`,
      title: `Library Movie ${tmdbId}`,
      type: 'movie' as const,
      tmdbId,
    }))
  );

  const tmdbClient = (sync as any).tmdbClient;
  vi.spyOn(tmdbClient, 'getMovie').mockImplementation((async ({
    movieId,
  }: {
    movieId: number;
  }) => {
    const entry = tmdb.movies[movieId];
    if (entry === 'reject') {
      throw new Error(`TMDB movie fetch failed for ${movieId}`);
    }
    return {
      id: movieId,
      title: `Movie ${movieId}`,
      belongs_to_collection: entry?.collectionId
        ? { id: entry.collectionId, name: `Collection ${entry.collectionId}` }
        : undefined,
    };
  }) as any);

  vi.spyOn(tmdbClient, 'getCollection').mockImplementation((async ({
    collectionId,
  }: {
    collectionId: number;
  }) => {
    const parts = tmdb.collections[collectionId];
    if (parts === 'reject') {
      throw new Error(`TMDB collection fetch failed for ${collectionId}`);
    }
    if (parts === null) {
      // Simulates a dropped/empty TMDB response body - collectionData itself is
      // null, distinct from a valid object with missing/empty `parts`.
      return null;
    }
    return {
      id: collectionId,
      name: `Collection ${collectionId}`,
      parts: parts.map((p) => ({
        id: p.id,
        title: p.title ?? `Part ${p.id}`,
        release_date: p.release_date,
      })),
    };
  }) as any);

  vi.spyOn(sync as any, 'findPlexItemsForFranchise').mockImplementation(((
    franchiseData: TmdbFranchiseSourceData
  ) =>
    Promise.resolve(
      franchiseData.movies.map((movie, index) => ({
        ratingKey: `${franchiseData.franchiseId}-${index}`,
        title: movie.title,
        type: 'movie' as const,
        tmdbId: movie.tmdbId,
      }))
    )) as any);

  vi.spyOn(sync, 'createOrUpdateCollectionStandardized').mockResolvedValue({
    created: 1,
    updated: 0,
  } as any);
};

describe('fork#96: Auto Franchise placeholder membership', () => {
  beforeEach(() => {
    placeholderStore.clear();
    handlePlaceholderCleanupMock.mockClear();
    syncCacheService.clear();
  });

  it('property 1: default path (no override) computes sourceTmdbIds exactly as before - the 12 non-franchise sources are untouched', async () => {
    const cfg = config();
    placeholderStore.set(cfg.id, new Map([[555, { title: 'stale' }]]));

    const sync = new TmdbCollectionSync();
    const plexClient = {} as PlexAPI;

    await (sync as any).handlePlaceholdersAndMissingItems(
      [{ ratingKey: '9', title: 'Only Item', type: 'movie', tmdbId: 999 }],
      [
        {
          tmdbId: 888,
          mediaType: 'movie',
          title: 'Missing',
          originalPosition: 1,
          source: 'tmdb',
        },
      ],
      cfg,
      plexClient,
      undefined,
      undefined
    );

    expect(handlePlaceholderCleanupMock).toHaveBeenCalledTimes(1);
    const sourceTmdbIds = handlePlaceholderCleanupMock.mock
      .calls[0][3] as Set<number>;
    expect(sourceTmdbIds).toEqual(new Set([999, 888]));
    // Unrelated stale record still gets orphaned exactly as pre-fix - default
    // behaviour is byte-for-byte unchanged (BaseCollectionSync.ts has zero diff
    // against origin/develop after round 2).
    expect(placeholderStore.get(cfg.id)?.has(555)).toBe(false);
  });

  it('property 2 (round 2): cleanup runs ONCE for the whole config sync, not once per franchise, and franchise A survives franchise B being processed', async () => {
    const cfg = config();
    const franchiseA = franchise(1, 'Franchise A', [100, 101]);
    const franchiseB = franchise(2, 'Franchise B', [200, 201]);

    // Franchise A's placeholders already exist from a prior sync.
    placeholderStore.set(
      cfg.id,
      new Map([
        [100, { title: 'A1' }],
        [101, { title: 'A2' }],
      ])
    );

    const sync = new TmdbCollectionSync();
    wireFranchises(
      sync,
      [
        [1, franchiseA],
        [2, franchiseB],
      ],
      [
        { ratingKey: '1', title: 'A1', type: 'movie', tmdbId: 100 },
        { ratingKey: '2', title: 'A2', type: 'movie', tmdbId: 101 },
        { ratingKey: '3', title: 'B1', type: 'movie', tmdbId: 200 },
        { ratingKey: '4', title: 'B2', type: 'movie', tmdbId: 201 },
      ]
    );

    await (sync as any).processFranchiseCollections(cfg, {} as PlexAPI, []);

    // MultiSourceOrchestrator shape: exactly one cleanup call for the whole sync,
    // not one per franchise (ponytail Important finding #1 - N retroactive-filter
    // evaluations per sync).
    expect(handlePlaceholderCleanupMock).toHaveBeenCalledTimes(1);

    // Franchise A's placeholders must survive franchise B's processing.
    expect(placeholderStore.get(cfg.id)?.has(100)).toBe(true);
    expect(placeholderStore.get(cfg.id)?.has(101)).toBe(true);

    // The one cleanup call must see the whole config's membership union.
    const sourceTmdbIds = handlePlaceholderCleanupMock.mock
      .calls[0][3] as Set<number>;
    expect(sourceTmdbIds).toEqual(new Set([100, 101, 200, 201]));
  });

  it('property 3: a mid-loop item-fetch failure in one franchise cannot affect the (already-run) cleanup call or its union', async () => {
    const cfg = config();
    const franchiseA = franchise(1, 'Franchise A', [100, 101]);
    const franchiseB = franchise(2, 'Franchise B', [200, 201]); // this one fails
    const franchiseC = franchise(3, 'Franchise C', [300, 301]);

    // B already has DB-tracked placeholders; they must not be deleted just
    // because B's own Plex lookup throws this sync.
    placeholderStore.set(
      cfg.id,
      new Map([
        [200, { title: 'B1' }],
        [201, { title: 'B2' }],
      ])
    );

    const sync = new TmdbCollectionSync();
    wireFranchises(
      sync,
      [
        [1, franchiseA],
        [2, franchiseB],
        [3, franchiseC],
      ],
      [
        { ratingKey: '1', title: 'A1', type: 'movie', tmdbId: 100 },
        { ratingKey: '2', title: 'A2', type: 'movie', tmdbId: 101 },
        { ratingKey: '3', title: 'B1', type: 'movie', tmdbId: 200 },
        { ratingKey: '4', title: 'B2', type: 'movie', tmdbId: 201 },
        { ratingKey: '5', title: 'C1', type: 'movie', tmdbId: 300 },
        { ratingKey: '6', title: 'C2', type: 'movie', tmdbId: 301 },
      ],
      { failForFranchiseId: 2 }
    );

    const result = await (sync as any).processFranchiseCollections(
      cfg,
      {} as PlexAPI,
      []
    );

    // The outer per-franchise try/catch absorbs B's failure; the sync completes.
    // Cleanup already ran (once, before the loop) so B's later throw can't touch it.
    expect(result).toEqual({ created: 2, updated: 0 });
    expect(handlePlaceholderCleanupMock).toHaveBeenCalledTimes(1);

    const sourceTmdbIds = handlePlaceholderCleanupMock.mock
      .calls[0][3] as Set<number>;
    expect(sourceTmdbIds).toEqual(new Set([100, 101, 200, 201, 300, 301]));

    // B's own placeholders survive (untouched this run) rather than being deleted.
    expect(placeholderStore.get(cfg.id)?.has(200)).toBe(true);
    expect(placeholderStore.get(cfg.id)?.has(201)).toBe(true);
  });

  it('property 4a: a movie-fetch OR collection-fetch rejection increments failedCount and skips cleanup end-to-end (real discoverFranchises)', async () => {
    const cfg = config();
    // A pre-existing stale placeholder unrelated to any franchise below - it must
    // survive because cleanup should never run this sync.
    placeholderStore.set(cfg.id, new Map([[999, { title: 'stale' }]]));

    const sync = new TmdbCollectionSync();
    wireRealDiscovery(sync, [400, 500, 600], {
      movies: {
        400: 'reject', // movie-detail fetch itself throws
        500: { collectionId: 5000 },
        600: { collectionId: 6000 },
      },
      collections: {
        5000: 'reject', // collection fetch throws after the movie fetch succeeded
        6000: [{ id: 600 }, { id: 601 }],
      },
    });

    const result = await (sync as any).processFranchiseCollections(
      cfg,
      {} as PlexAPI,
      []
    );

    expect(handlePlaceholderCleanupMock).not.toHaveBeenCalled();
    expect(placeholderStore.get(cfg.id)?.has(999)).toBe(true);
    // The one franchise that discovered cleanly still gets created - only orphan
    // cleanup is gated on discovery completeness, not per-franchise creation.
    expect(result).toEqual({ created: 1, updated: 0 });
  });

  it('property 4b: a null collection response increments failedCount and skips cleanup end-to-end (real discoverFranchises)', async () => {
    const cfg = config();
    placeholderStore.set(cfg.id, new Map([[999, { title: 'stale' }]]));

    const sync = new TmdbCollectionSync();
    wireRealDiscovery(sync, [700, 800, 801], {
      movies: {
        700: { collectionId: 7000 },
        800: { collectionId: 8000 },
        801: { collectionId: 8000 },
      },
      collections: {
        7000: null, // dropped/empty TMDB response body
        8000: [{ id: 800 }, { id: 801 }],
      },
    });

    const result = await (sync as any).processFranchiseCollections(
      cfg,
      {} as PlexAPI,
      []
    );

    expect(handlePlaceholderCleanupMock).not.toHaveBeenCalled();
    expect(placeholderStore.get(cfg.id)?.has(999)).toBe(true);
    expect(result).toEqual({ created: 1, updated: 0 });
  });

  it('property 4c (new behaviour): an empty parts array increments failedCount and skips cleanup end-to-end, instead of being recorded as a successful empty franchise', async () => {
    const cfg = config();
    placeholderStore.set(cfg.id, new Map([[999, { title: 'stale' }]]));

    const sync = new TmdbCollectionSync();
    wireRealDiscovery(sync, [900, 1000, 1001], {
      movies: {
        900: { collectionId: 9000 },
        1000: { collectionId: 10000 },
        1001: { collectionId: 10000 },
      },
      collections: {
        9000: [], // valid response, zero parts - must not silently succeed
        10000: [{ id: 1000 }, { id: 1001 }],
      },
    });

    const result = await (sync as any).processFranchiseCollections(
      cfg,
      {} as PlexAPI,
      []
    );

    expect(handlePlaceholderCleanupMock).not.toHaveBeenCalled();
    expect(placeholderStore.get(cfg.id)?.has(999)).toBe(true);
    expect(result).toEqual({ created: 1, updated: 0 });
  });

  it('property 4d: all franchises discover cleanly - failedCount is 0, cleanup runs once with the full union, and a string-typed part id is coerced in rather than dropped', async () => {
    const cfg = config();
    // A genuinely stale record (not part of any discovered franchise) - it should
    // be deleted, proving cleanup actually ran, not just that it was called.
    placeholderStore.set(
      cfg.id,
      new Map([
        [1100, { title: 'A1' }],
        [1101, { title: 'A2' }],
        [9999, { title: 'stale' }],
      ])
    );

    const sync = new TmdbCollectionSync();
    wireRealDiscovery(sync, [1100, 1101, 1200, 1201], {
      movies: {
        1100: { collectionId: 11000 },
        1101: { collectionId: 11000 },
        1200: { collectionId: 12000 },
        1201: { collectionId: 12000 },
      },
      collections: {
        11000: [{ id: 1100 }, { id: 1101 }],
        // TMDB's `id` field is documented as numeric, but a string-typed id in a
        // real response must still enter the union - placeholders are keyed by the
        // numeric id they had at creation.
        12000: [{ id: '1200' }, { id: 1201 }],
      },
    });

    const result = await (sync as any).processFranchiseCollections(
      cfg,
      {} as PlexAPI,
      []
    );

    expect(handlePlaceholderCleanupMock).toHaveBeenCalledTimes(1);
    const sourceTmdbIds = handlePlaceholderCleanupMock.mock
      .calls[0][3] as Set<number>;
    expect(sourceTmdbIds).toEqual(new Set([1100, 1101, 1200, 1201]));
    expect(sourceTmdbIds.has(1200)).toBe(true); // coerced from the string "1200"

    // Cleanup actually ran: the genuinely stale record is gone, the real ones stay.
    expect(placeholderStore.get(cfg.id)?.has(9999)).toBe(false);
    expect(placeholderStore.get(cfg.id)?.has(1100)).toBe(true);
    expect(placeholderStore.get(cfg.id)?.has(1101)).toBe(true);

    expect(result).toEqual({ created: 2, updated: 0 });
  });
});

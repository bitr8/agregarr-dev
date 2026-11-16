import type PlexAPI from '@server/api/plexapi';
import type { CollectionConfig } from '@server/lib/settings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectionItem } from './types';
import { CollectionSyncErrorType } from './types';

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/entity/CollectionMetadata', () => ({
  CollectionMetadata: class {},
}));
vi.mock('@server/entity/CollectionMissingItems', () => ({
  CollectionMissingItems: class {},
}));
vi.mock('@server/entity/PosterTemplate', () => ({ PosterTemplate: class {} }));
vi.mock('@server/entity/User', () => ({ User: class {} }));
vi.mock('@server/api/imdbRatings', () => ({ default: class {} }));
vi.mock('@server/lib/cache', () => ({ default: { getCache: vi.fn() } }));
vi.mock('@server/lib/posterStorage', () => ({ generatePoster: vi.fn() }));
vi.mock('@server/lib/collections/services/ServiceUserManager', () => ({
  serviceUserManager: {},
}));
vi.mock('@server/lib/collections/utils/TemplateEngine', () => ({
  templateEngine: {},
}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const save = vi.fn();
const settings = {
  clientId: 'test-client',
  main: {},
  plex: {
    collectionConfigs: [] as CollectionConfig[],
    sortTitleArticleHandling: undefined as string | undefined,
  },
  save,
};
vi.mock('@server/lib/settings', () => ({ getSettings: () => settings }));

import { getRepository } from '@server/datasource';
import logger from '@server/logger';
import { BaseCollectionSync } from './BaseCollectionSync';
import { extractErrorCause } from './CollectionUtilities';

class TestSync extends BaseCollectionSync<'tmdb'> {
  constructor() {
    super('tmdb');
  }
  protected async validateConfiguration(): Promise<void> {
    return;
  }
  protected async processConfiguration(): Promise<never> {
    throw new Error('not used');
  }
  protected createTemplateContext(): never {
    throw new Error('not used');
  }
  public async fetchSourceData(): Promise<never> {
    throw new Error('not used');
  }
  public mapSourceDataToItems(): never {
    throw new Error('not used');
  }
  protected async createCollection(): Promise<never> {
    throw new Error('not used');
  }
}

const config = (overrides: Partial<CollectionConfig> = {}): CollectionConfig =>
  ({
    id: '10',
    name: 'Neon Noir',
    type: 'tmdb',
    subtype: 'trending',
    libraryId: '4',
    isActive: true,
    ...overrides,
  } as CollectionConfig);

// A client that gets as far as creating the collection and then fails, which is
// the window the fix exists to cover. The first call each path makes after
// creation throws: addItemsToCollection for a regular collection,
// addLabelToCollection (via updateCollectionMetadata) for a smart one.
const failAfterCreate = (createdKey: string | null) => {
  const boom = async () => {
    throw new Error('Plex went away mid-create');
  };
  return {
    createEmptyCollection: vi.fn(async () => createdKey),
    createLabelBasedSmartCollection: vi.fn(async () => createdKey),
    addItemsToCollection: vi.fn(boom),
    addLabelToCollection: vi.fn(boom),
    addLabelToItem: vi.fn(async () => undefined),
    getItemsWithLabel: vi.fn(async () => []),
    getCollectionMetadata: vi.fn(async () => null),
    plexClient: {
      query: vi.fn(async () => ({ MediaContainer: { Metadata: [] } })),
    },
  } as unknown as PlexAPI;
};

const run = (plexClient: PlexAPI, cfg: CollectionConfig) =>
  new TestSync().createOrUpdateCollectionStandardized(
    [{ ratingKey: '55', title: 'Blade Runner', type: 'movie' }],
    cfg.name,
    'movie',
    cfg,
    plexClient,
    []
  );

const stored = () => settings.plex.collectionConfigs[0]?.collectionRatingKey;

describe('createOrUpdateCollectionStandardized: key survives a failed create', () => {
  beforeEach(() => {
    save.mockClear();
    settings.plex.collectionConfigs = [config()];
  });

  it('stores the ratingKey of a regular collection before adding items', async () => {
    await expect(run(failAfterCreate('187606'), config())).rejects.toThrow();

    // Without this the next sync cannot recognise the unlabeled collection it
    // just made, refuses it, and creates a duplicate every sync thereafter.
    expect(stored()).toBe('187606');
  });

  it('stores the ratingKey of a smart collection before the rest of the sync', async () => {
    const cfg = config({ showUnwatchedOnly: true });
    settings.plex.collectionConfigs = [cfg];

    await expect(run(failAfterCreate('187607'), cfg)).rejects.toThrow();

    expect(stored()).toBe('187607');
  });

  it('stores nothing when Plex never returned a key', async () => {
    await expect(run(failAfterCreate(null), config())).rejects.toThrow();

    expect(stored()).toBeUndefined();
  });

  it('leaves multi-collection configs alone, they hold one key per collection', async () => {
    const cfg = config({ type: 'overseerr', subtype: 'users' });
    settings.plex.collectionConfigs = [cfg];

    await expect(run(failAfterCreate('187608'), cfg)).rejects.toThrow();

    expect(stored()).toBeUndefined();
  });
});

describe('createOrUpdateCollectionStandardized: filterUnwatched threading', () => {
  beforeEach(() => {
    save.mockClear();
  });

  it('defaults filterUnwatched to true when the config omits it', async () => {
    const cfg = config({ showUnwatchedOnly: true });
    settings.plex.collectionConfigs = [cfg];
    const plexClient = failAfterCreate('187609');

    await expect(run(plexClient, cfg)).rejects.toThrow();

    const createMock = plexClient.createLabelBasedSmartCollection as ReturnType<
      typeof vi.fn
    >;
    expect(createMock.mock.calls[0][7]).toBe(true);
  });

  it('passes filterUnwatched: false through to the Plex client', async () => {
    const cfg = config({ showUnwatchedOnly: true, filterUnwatched: false });
    settings.plex.collectionConfigs = [cfg];
    const plexClient = failAfterCreate('187610');

    await expect(run(plexClient, cfg)).rejects.toThrow();

    const createMock = plexClient.createLabelBasedSmartCollection as ReturnType<
      typeof vi.fn
    >;
    expect(createMock.mock.calls[0][7]).toBe(false);
  });
});

describe('createOrUpdateCollectionStandardized: stale item in a smart collection', () => {
  it('skips an item whose label apply 404s instead of aborting the sync', async () => {
    const cfg = config({ showUnwatchedOnly: true });
    settings.plex.collectionConfigs = [cfg];
    const plexClient = failAfterCreate('187611');
    const labelMock = plexClient.addLabelToItem as ReturnType<typeof vi.fn>;
    (plexClient as unknown as { recordPhaseTime: unknown }).recordPhaseTime =
      vi.fn();
    const removeMock = vi.fn();
    (
      plexClient as unknown as { removeLabelFromItem: unknown }
    ).removeLabelFromItem = removeMock;
    (
      plexClient.getItemsWithLabel as ReturnType<typeof vi.fn>
    ).mockResolvedValue(['189997', '197176', '555000']);
    labelMock.mockImplementation(async (key: string) => {
      if (key === '189997') {
        throw new Error('response code: 404');
      }
    });

    await expect(
      new TestSync().createOrUpdateCollectionStandardized(
        [
          { ratingKey: '189997', title: 'Stale', type: 'movie' },
          { ratingKey: '197176', title: 'Current', type: 'movie' },
        ],
        cfg.name,
        'movie',
        cfg,
        plexClient,
        []
      )
    ).rejects.toThrow('Plex went away mid-create');

    expect(labelMock).toHaveBeenCalledWith('197176', 'agregarr-unwatched-10');
    expect(removeMock).toHaveBeenCalledWith('555000', 'agregarr-unwatched-10');
    expect(removeMock).not.toHaveBeenCalledWith('189997', expect.anything());
  });

  it('throws before cleanup when every item is stale, so nothing is unlabelled', async () => {
    const cfg = config({ showUnwatchedOnly: true });
    settings.plex.collectionConfigs = [cfg];
    const plexClient = failAfterCreate('187613');
    (plexClient as unknown as { recordPhaseTime: unknown }).recordPhaseTime =
      vi.fn();
    const removeMock = vi.fn();
    (
      plexClient as unknown as { removeLabelFromItem: unknown }
    ).removeLabelFromItem = removeMock;
    (
      plexClient.getItemsWithLabel as ReturnType<typeof vi.fn>
    ).mockResolvedValue(['555000', '555001']);
    (plexClient.addLabelToItem as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('response code: 404')
    );

    await expect(
      new TestSync().createOrUpdateCollectionStandardized(
        [
          { ratingKey: '189997', title: 'Stale A', type: 'movie' },
          { ratingKey: '197176', title: 'Stale B', type: 'movie' },
        ],
        cfg.name,
        'movie',
        cfg,
        plexClient,
        []
      )
    ).rejects.toThrow('response code: 404');

    expect(plexClient.getItemsWithLabel).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });
});

describe.each([
  [
    '503',
    'Plex Server didnt respond with a valid 2xx status code, response code: 503',
  ],
  ['network error without a status', 'connect ECONNREFUSED 127.0.0.1:32400'],
  [
    '404-looking ratingKey with another status',
    'PUT /library/metadata/40412 failed, response code: 500',
  ],
])('createOrUpdateCollectionStandardized: label failure (%s)', (_name, msg) => {
  it('still rejects and cleans nothing up', async () => {
    const cfg = config({ showUnwatchedOnly: true });
    settings.plex.collectionConfigs = [cfg];
    const plexClient = failAfterCreate('187612');
    (plexClient.addLabelToItem as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error(msg)
    );
    (
      plexClient as unknown as { removeLabelFromItem: unknown }
    ).removeLabelFromItem = vi.fn();
    const getLabeled = plexClient.getItemsWithLabel as ReturnType<typeof vi.fn>;

    await expect(run(plexClient, cfg)).rejects.toThrow(msg);

    expect(getLabeled).not.toHaveBeenCalled();
    expect(
      (
        plexClient as unknown as {
          removeLabelFromItem: ReturnType<typeof vi.fn>;
        }
      ).removeLabelFromItem
    ).not.toHaveBeenCalled();
  });
});

// Mirrors radarr.ts's own processConfiguration catch: wraps a real failure
// into a CollectionSyncError plain object (not an Error instance) before it
// reaches processCollections' outer catch, which is where fork#76b's
// "[object Object]" swallow happened.
class ThrowingSync extends BaseCollectionSync<'tmdb'> {
  constructor(private readonly innerError: Error) {
    super('tmdb');
  }
  protected async validateConfiguration(): Promise<void> {
    return;
  }
  protected async processConfiguration(cfg: CollectionConfig): Promise<never> {
    throw this.createSyncError(
      CollectionSyncErrorType.COLLECTION_ERROR,
      `Failed to process Radarr Tag collection ${cfg.name}`,
      { configId: cfg.id, configName: cfg.name },
      this.innerError
    );
  }
  protected createTemplateContext(): never {
    throw new Error('not used');
  }
  public async fetchSourceData(): Promise<never> {
    throw new Error('not used');
  }
  public mapSourceDataToItems(): never {
    throw new Error('not used');
  }
  protected async createCollection(): Promise<never> {
    throw new Error('not used');
  }
}

describe('processCollections: surfaces the real cause instead of [object Object]', () => {
  beforeEach(() => {
    vi.mocked(logger.error).mockClear();
    settings.plex.collectionConfigs = [config()];
  });

  it('logs the inner cause on the final "Failed to process configuration" line', async () => {
    const innerError = new Error('Request failed with status code 401');
    const sync = new ThrowingSync(innerError);
    const onError = vi.fn();

    await sync.processCollections(
      [config()],
      {} as PlexAPI,
      [],
      undefined,
      undefined,
      { onError }
    );

    // The propagated cause, exactly as it would reach a caller inspecting
    // syncError.originalError. Before the fix this stringified to "[object
    // Object]" (String() of a plain CollectionSyncError literal).
    expect(onError).toHaveBeenCalledTimes(1);
    const syncError = onError.mock.calls[0][0] as {
      originalError?: Error;
    };
    expect(syncError.originalError).toBeInstanceOf(Error);
    expect(syncError.originalError?.message).not.toBe('[object Object]');
    expect(syncError.originalError?.message).toBe(
      'Request failed with status code 401'
    );
    // Logging-only contract: a FRESH Error, never the caught inner object
    // returned by reference — consumers of onError must keep seeing what
    // they always saw (a rebuilt Error), never the raw AxiosError/etc.
    expect(syncError.originalError).not.toBe(innerError);

    const errorCalls = vi.mocked(logger.error).mock.calls as unknown as [
      string,
      { error?: string; cause?: string }
    ][];
    const finalCall = errorCalls.find(([message]) =>
      message.startsWith('Failed to process configuration')
    );

    expect(finalCall).toBeDefined();
    const meta = finalCall?.[1];

    // `error` carries the stage/wrapper text, `cause` the deep message —
    // mirrors overseerrSync.ts's error+cause logging convention.
    expect(meta?.error).not.toBe('[object Object]');
    expect(meta?.error).toBe(
      'Failed to process Radarr Tag collection Neon Noir'
    );
    expect(meta?.cause).toBe('Request failed with status code 401');
  });
});

describe('processCollections: a failed config reaches the result', () => {
  it('sets result.error with the cause so callers do not mark the sync green', async () => {
    settings.plex.collectionConfigs = [config()];
    const sync = new ThrowingSync(new Error('solver in backoff'));

    const result = await sync.processCollections([config()], {} as PlexAPI, []);

    expect(result.error).toBe(
      'Failed to process configuration Neon Noir: solver in backoff'
    );
    expect(result.created).toBe(0);
  });
});

class NestedThrowingSync extends ThrowingSync {
  protected async processConfiguration(cfg: CollectionConfig): Promise<never> {
    try {
      throw this.createSyncError(
        CollectionSyncErrorType.API_ERROR,
        'Failed to fetch list: solver in backoff'
      );
    } catch (error) {
      throw this.createSyncError(
        CollectionSyncErrorType.COLLECTION_ERROR,
        `Failed to process collection ${cfg.name}`,
        { configId: cfg.id },
        extractErrorCause(error)
      );
    }
  }
}

describe('processCollections: nested sync errors keep their message in result.error', () => {
  it('does not render [object Object]', async () => {
    settings.plex.collectionConfigs = [config()];
    const sync = new NestedThrowingSync(new Error('unused'));

    const result = await sync.processCollections([config()], {} as PlexAPI, []);

    expect(result.error).not.toContain('[object Object]');
    expect(result.error).toBe(
      'Failed to process configuration Neon Noir: Failed to fetch list: solver in backoff'
    );
  });
});

describe('createOrUpdateCollectionStandardized: smart collections never own missing-item rows', () => {
  const repo = { delete: vi.fn(), insert: vi.fn() };

  beforeEach(() => {
    save.mockClear();
    repo.delete.mockClear();
    repo.insert.mockClear();
    vi.mocked(getRepository).mockReturnValue(repo as never);
  });

  afterEach(() => {
    vi.mocked(getRepository).mockReset();
  });

  it('clears existing rows for a newly created smart collection', async () => {
    const cfg = config({ showUnwatchedOnly: true, autoPoster: false });
    settings.plex.collectionConfigs = [cfg];
    const plexClient = {
      createLabelBasedSmartCollection: vi.fn(async () => '403900'),
      addLabelToItem: vi.fn(async () => undefined),
      getItemsWithLabel: vi.fn(async () => []),
      addLabelToCollection: vi.fn(async () => undefined),
      updateCollectionTitle: vi.fn(async () => undefined),
      updateCollectionVisibility: vi.fn(async () => undefined),
      recordPhaseTime: vi.fn(),
      plexClient: {
        query: vi.fn(async () => ({ MediaContainer: { Metadata: [] } })),
      },
    } as unknown as PlexAPI;

    const result = await run(plexClient, cfg);

    expect(result.collectionRatingKey).toBe('403900');
    expect(repo.delete).toHaveBeenCalledWith({
      collectionRatingKey: '403900',
    });
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('clears the old key when a regular config replaces a smart collection', async () => {
    const cfg = config({
      collectionRatingKey: 'OLD_SMART_KEY',
      autoPoster: false,
    });
    settings.plex.collectionConfigs = [cfg];
    const oldSmartMeta = {
      ratingKey: 'OLD_SMART_KEY',
      title: cfg.name,
      labels: [],
      type: 'collection',
      librarySectionID: cfg.libraryId,
      smart: '1',
    };
    const plexClient = {
      getCollectionMetadata: vi.fn(async () => oldSmartMeta),
      getItemsWithLabel: vi.fn(async () => []),
      deleteCollection: vi.fn(async () => undefined),
      createEmptyCollection: vi.fn(async () => 'NEW_REGULAR_KEY'),
      addItemsToCollection: vi.fn(async () => undefined),
      updateCollectionContentSort: vi.fn(async () => undefined),
      addLabelToCollection: vi.fn(async () => undefined),
      updateCollectionTitle: vi.fn(async () => undefined),
      updateCollectionVisibility: vi.fn(async () => undefined),
      recordPhaseTime: vi.fn(),
    } as unknown as PlexAPI;

    const result = await run(plexClient, cfg);

    expect(result.collectionRatingKey).toBe('NEW_REGULAR_KEY');
    expect(repo.delete).toHaveBeenCalledWith({
      collectionRatingKey: 'OLD_SMART_KEY',
    });
  });

  it('stores missing items for a regular collection', async () => {
    const missingItems = [
      {
        tmdbId: 1,
        mediaType: 'movie' as const,
        title: 'Missing Movie',
        originalPosition: 1,
        source: 'tmdb',
      },
    ];
    const cfg = config({ autoPoster: false });
    settings.plex.collectionConfigs = [cfg];
    const sync = new TestSync();
    (sync as unknown as Record<string, unknown>).createOrUpdateCollection =
      vi.fn(async () => ({
        created: 1,
        updated: 0,
        collectionRatingKey: '403901',
        itemCount: 1,
        isSmartCollection: false,
      }));

    await sync.createOrUpdateCollectionStandardized(
      [{ ratingKey: '55', title: 'Blade Runner', type: 'movie' }],
      cfg.name,
      'movie',
      cfg,
      {} as PlexAPI,
      [],
      undefined,
      undefined,
      missingItems as never
    );

    expect(repo.insert).toHaveBeenCalledTimes(1);
  });
});

describe('createOrUpdateCollectionStandardized: target user label', () => {
  it('labels the collection with the target-user label when the caller passes no userInfo', async () => {
    const cfg = config({ showUnwatchedOnly: true, targetUserId: '1001' });
    settings.plex.collectionConfigs = [cfg];
    const plexClient = failAfterCreate('187611');

    await expect(run(plexClient, cfg)).rejects.toThrow();

    const createMock = plexClient.createLabelBasedSmartCollection as ReturnType<
      typeof vi.fn
    >;
    expect(createMock.mock.calls[0][5]).toBe('AgregarrTargetUser_10_1001');
  });
});

describe('updateCollectionMetadata: sort title PUTs', () => {
  // Real PlexAPI, so the unchanged-value skip runs; only the PUT is stubbed.
  const setup = async () => {
    const { default: PlexAPI } = await import('@server/api/plexapi');
    const api = new PlexAPI({
      plexToken: 'test-token',
      plexSettings: {
        name: 'test',
        ip: '127.0.0.1',
        port: 32400,
        libraries: [],
      },
    });
    vi.spyOn(api, 'addLabelToCollection').mockResolvedValue(true);
    vi.spyOn(api, 'updateCollectionTitle').mockResolvedValue(undefined);
    const put = vi
      .spyOn(
        api as unknown as { safePutQuery: (url: string) => Promise<void> },
        'safePutQuery'
      )
      .mockResolvedValue(undefined);
    const sortTitlePuts = () =>
      put.mock.calls.filter(([url]) => url.includes('titleSort'));
    return { api, sortTitlePuts };
  };

  // Plex omits titleSort when it equals the title, so it arrives undefined.
  const sync = (api: PlexAPI, cfg: CollectionConfig, title: string) =>
    (
      new TestSync() as unknown as {
        updateCollectionMetadata: (
          plexClient: PlexAPI,
          ratingKey: string,
          options: Record<string, unknown>
        ) => Promise<unknown>;
      }
    ).updateCollectionMetadata(api, '900', {
      collectionName: title,
      mediaType: 'movie',
      customLabel: 'Agregarr',
      libraryKey: '4',
      config: cfg,
      existingTitle: title,
      existingTitleSort: undefined,
    });

  afterEach(() => {
    settings.plex.sortTitleArticleHandling = undefined;
  });

  it('does not rewrite an unchanged sort title on a second sync under strip', async () => {
    settings.plex.sortTitleArticleHandling = 'strip';
    const cfg = config({
      everLibraryPromoted: false,
      isLibraryPromoted: false,
      sortOrderLibrary: 0,
    });
    settings.plex.collectionConfigs = [cfg];
    const { api, sortTitlePuts } = await setup();

    await sync(api, cfg, 'Neon Noir');

    expect(sortTitlePuts()).toHaveLength(0);
  });

  it('does not rewrite a restored group member on repeated off syncs', async () => {
    settings.plex.sortTitleArticleHandling = 'off';
    const cfg = config({
      type: 'plex',
      subtype: 'genre',
      everLibraryPromoted: false,
      isLibraryPromoted: false,
      sortOrderLibrary: 0,
      sortTitleArticleNormalized: true,
    });
    settings.plex.collectionConfigs = [cfg];
    const { api, sortTitlePuts } = await setup();

    await sync(api, cfg, 'The Matrix Collection');
    await sync(api, cfg, 'The Matrix Collection');

    expect(sortTitlePuts()).toHaveLength(0);
  });

  it('still writes when the normalized value differs from the title', async () => {
    settings.plex.sortTitleArticleHandling = 'strip';
    const cfg = config({
      everLibraryPromoted: false,
      isLibraryPromoted: false,
      sortOrderLibrary: 0,
    });
    settings.plex.collectionConfigs = [cfg];
    const { api, sortTitlePuts } = await setup();

    await sync(api, cfg, 'The Matrix Collection');

    expect(sortTitlePuts()).toHaveLength(1);
    expect(String(sortTitlePuts()[0][0])).toContain(
      encodeURIComponent('Matrix Collection')
    );
  });
});

describe('mergePlaceholders and capToMaxItems', () => {
  const sync = new TestSync() as unknown as {
    mergePlaceholders: (...a: unknown[]) => CollectionItem[];
    capToMaxItems: (...a: unknown[]) => CollectionItem[];
  };
  const run = (
    items: CollectionItem[],
    placeholders: CollectionItem[],
    missing: { tmdbId: number; originalPosition: number }[],
    config: Partial<CollectionConfig>,
    excluded: number[] = []
  ) =>
    sync.capToMaxItems(
      sync
        .mergePlaceholders(items, placeholders, missing, config)
        .filter((i) => !excluded.includes(i.tmdbId as number)),
      config
    );
  const present = (tmdbId: number, p?: number) =>
    ({
      ratingKey: `rk${tmdbId}`,
      tmdbId,
      metadata: p === undefined ? {} : { originalPosition: p },
    } as unknown as CollectionItem);
  const ph = (tmdbId: number) =>
    ({
      ratingKey: `ph${tmdbId}`,
      tmdbId,
      type: 'movie',
    } as unknown as CollectionItem);
  const ids = (list: CollectionItem[]) => list.map((i) => i.tmdbId);
  const rows = (...ns: number[]) =>
    ns.map((n) => ({ tmdbId: n, mediaType: 'movie', originalPosition: n }));

  it('puts placeholders at their list position and keeps Max Items', () => {
    const out = run(
      [present(1, 1), present(3, 3), present(5, 5)],
      [ph(2), ph(4)],
      rows(2, 4),
      { maxItems: 4 }
    );
    expect(ids(out)).toEqual([1, 2, 3, 4]);
  });

  it('places placeholders by position when the collection fits', () => {
    const out = run([present(1, 1), present(3, 3)], [ph(2)], rows(2), {
      maxItems: 10,
    });
    expect(ids(out)).toEqual([1, 2, 3]);
  });

  it('lets placeholders take the slots of excluded items', () => {
    const out = run(
      [present(1, 1), present(2, 2), present(3, 3)],
      [ph(4), ph(5)],
      rows(4, 5),
      { maxItems: 3 },
      [1]
    );
    expect(ids(out)).toEqual([2, 3, 4]);
  });

  it('fills free slots after the sorted items under any other sort', () => {
    const out = run(
      [present(5, 5), present(1, 1)],
      [ph(2), ph(3)],
      rows(2, 3),
      { maxItems: 3, sortOrder: 'imdb_rating_desc' }
    );
    expect(ids(out)).toEqual([5, 1, 2]);
  });

  it('gives a placeholder its own media type position, first row wins', () => {
    const out = sync.mergePlaceholders(
      [present(1, 1), present(4, 4)],
      [{ ...ph(7), type: 'tv' } as CollectionItem],
      [
        { tmdbId: 7, mediaType: 'movie', originalPosition: 3 },
        { tmdbId: 7, mediaType: 'tv', originalPosition: 2 },
        { tmdbId: 7, mediaType: 'tv', originalPosition: 9 },
      ],
      { maxItems: 3 }
    );
    expect(out.map((i) => i.metadata?.originalPosition)).toEqual([1, 2, 4]);
  });

  it('still keeps Max Items when an item has no position', () => {
    const out = run([present(1), present(3, 3)], [ph(2)], rows(2), {
      maxItems: 2,
    });
    expect(ids(out)).toEqual([1, 3]);
  });

  it('changes nothing without placeholders or within the limit', () => {
    const items = [present(1, 1), present(2, 2)];
    expect(sync.mergePlaceholders(items, [], [], { maxItems: 2 })).toBe(items);
    expect(sync.capToMaxItems(items, { maxItems: 2 })).toBe(items);
    expect(sync.capToMaxItems(items, {})).toBe(items);
  });
});

describe('processWithMediaTypeStrategy applies Max Items after exclusions', () => {
  it('sends at most maxItems to collection creation', async () => {
    (settings.plex as Record<string, unknown>).libraries = [
      { key: '1', name: 'Movies', type: 'movie' },
    ];
    const sync = new TestSync() as unknown as {
      processWithMediaTypeStrategy: (...a: unknown[]) => Promise<unknown>;
      createOrUpdateCollectionStandardized: (...a: unknown[]) => unknown;
      generateCollectionNameWithCustom: () => Promise<string>;
    };
    const created = vi.fn(async () => ({ created: 1, updated: 0 }));
    sync.createOrUpdateCollectionStandardized = created;
    sync.generateCollectionNameWithCustom = async () => 'Name';
    const items = [1, 2, 3, 4].map(
      (n) =>
        ({
          ratingKey: `rk${n}`,
          tmdbId: n,
          type: 'movie',
          metadata: { originalPosition: n },
        } as unknown as CollectionItem)
    );
    await sync.processWithMediaTypeStrategy(
      items,
      {
        id: 'c',
        name: 'List',
        type: 'tmdb',
        libraryId: '1',
        mediaType: 'movie',
        maxItems: 3,
      },
      {} as PlexAPI,
      [],
      new Set()
    );
    const sent = (created.mock.calls[0] as unknown[])[0] as CollectionItem[];
    expect(sent.map((i) => i.tmdbId)).toEqual([1, 2, 3]);
  });
});

describe('handlePlaceholdersAndMissingItems candidate limit', () => {
  const requested = vi.fn(async () => undefined);
  let creatable: number[] = [];
  let allSeen: number[][] = [];
  const run = async (
    sortOrder: string | undefined,
    present: number,
    placeholders = true
  ) => {
    requested.mockClear();
    const sync = new TestSync() as unknown as {
      handlePlaceholdersAndMissingItems: (...a: unknown[]) => Promise<unknown>;
      processMissingItems: (...a: unknown[]) => Promise<unknown[]>;
    };
    const seen: number[][] = [];
    sync.processMissingItems = async (list: unknown) => {
      const ids = (list as { tmdbId: number }[]).map((m) => m.tmdbId);
      seen.push(ids);
      return ids
        .filter((id) => creatable.includes(id))
        .map((id) => ({ ratingKey: `ph${id}`, tmdbId: id }));
    };
    const items = Array.from({ length: present }, (_, i) => ({
      ratingKey: `rk${i}`,
      tmdbId: 100 + i,
    }));
    const missing = [5, 2, 9].map((n) => ({
      tmdbId: n,
      mediaType: 'movie',
      title: `T${n}`,
      originalPosition: n,
    }));
    await sync.handlePlaceholdersAndMissingItems(
      items,
      missing,
      {
        id: 'c',
        name: 'L',
        maxItems: 4,
        sortOrder,
        createPlaceholdersForMissing: placeholders,
      },
      {} as PlexAPI,
      undefined,
      requested
    );
    allSeen = seen;
    return seen[0];
  };

  it('only makes placeholders for free slots under another sort', async () => {
    expect(await run('imdb_rating_desc', 2)).toEqual([2, 5]);
  });

  it('gives a slot to the next missing item when one cannot be made', async () => {
    creatable = [5, 9];
    await run('imdb_rating_desc', 2);
    expect(allSeen).toEqual([[2, 5], [9]]);
    expect(requested).toHaveBeenCalledTimes(1);
    creatable = [];
  });

  it('still sends auto-requests when no placeholder slot is free', async () => {
    expect(await run('random', 4)).toBeUndefined();
    expect(requested).toHaveBeenCalledTimes(1);
  });

  it('leaves the missing list alone when placeholders are off', async () => {
    expect(await run('imdb_rating_desc', 4, false)).toEqual([5, 2, 9]);
  });

  it('passes every missing item through in source order', async () => {
    expect(await run(undefined, 4)).toEqual([5, 2, 9]);
  });
});

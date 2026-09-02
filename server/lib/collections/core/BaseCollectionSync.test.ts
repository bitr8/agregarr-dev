import type PlexAPI from '@server/api/plexapi';
import type { CollectionConfig } from '@server/lib/settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectionSyncErrorType } from './types';

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/entity/CollectionMetadata', () => ({
  CollectionMetadata: class {},
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
  plex: { collectionConfigs: [] as CollectionConfig[] },
  save,
};
vi.mock('@server/lib/settings', () => ({ getSettings: () => settings }));

import logger from '@server/logger';
import { BaseCollectionSync } from './BaseCollectionSync';

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
    id: 'cfg-1',
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

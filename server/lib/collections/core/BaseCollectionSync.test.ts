import type PlexAPI from '@server/api/plexapi';
import type { CollectionConfig } from '@server/lib/settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

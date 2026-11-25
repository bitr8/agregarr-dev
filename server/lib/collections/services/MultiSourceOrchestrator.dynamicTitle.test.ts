import type { MultiSourceCollectionConfig } from '@server/lib/settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/lib/placeholders/services/PlaceholderCleanup', () => ({
  handlePlaceholderCleanup: vi.fn(),
}));
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

const settings = vi.hoisted(() => ({
  plex: {
    libraries: [{ key: '4', type: 'movie' }],
    collectionConfigs: [] as unknown[],
  },
  save: () => undefined,
}));
vi.mock('@server/lib/settings', () => ({ getSettings: () => settings }));

import { MultiSourceOrchestrator } from './MultiSourceOrchestrator';

type Internals = {
  extractTitleFromSource: (...a: unknown[]) => Promise<string | null>;
  fetchItemsFromSource: (...a: unknown[]) => Promise<unknown>;
  createOrUpdatePlexCollection: (...a: unknown[]) => Promise<unknown>;
  processMultiSourceCollection: (...a: unknown[]) => Promise<unknown>;
};

const sources = [
  { id: 'source-1', type: 'trakt' },
  { id: 'source-2', type: 'imdb' },
];

const savedConfig = () =>
  settings.plex.collectionConfigs[0] as {
    name: string;
    syncCounter?: number;
  };

const run = async (items: unknown[]) => {
  const o = new MultiSourceOrchestrator() as unknown as Internals;
  vi.spyOn(o, 'extractTitleFromSource').mockResolvedValue('New List');
  vi.spyOn(o, 'fetchItemsFromSource').mockResolvedValue({ items });
  const write = vi
    .spyOn(o, 'createOrUpdatePlexCollection')
    .mockResolvedValue({ created: 0, updated: 1 });
  await o.processMultiSourceCollection(
    settings.plex.collectionConfigs[0] as MultiSourceCollectionConfig,
    {},
    []
  );
  return write;
};

describe('dynamic cycle title', () => {
  beforeEach(() => {
    settings.plex.collectionConfigs = [
      {
        id: '10',
        name: 'Old List',
        type: 'multi-source',
        libraryId: '4',
        libraryName: 'Movies',
        combineMode: 'cycle_lists',
        template: 'DYNAMIC_CYCLE_TITLE',
        syncCounter: 1,
        sources,
      },
    ];
  });

  it('keeps the saved name when the active list produced nothing', async () => {
    const write = await run([]);

    expect(write).not.toHaveBeenCalled();
    expect(savedConfig().name).toBe('Old List');
    expect(savedConfig().syncCounter).toBe(2);
  });

  it('saves the new name when the collection is updated', async () => {
    const write = await run([
      { ratingKey: '1', title: 'One', type: 'movie', tmdbId: 1 },
    ]);

    expect(write).toHaveBeenCalledTimes(1);
    expect(savedConfig().name).toBe('New List');
  });
});

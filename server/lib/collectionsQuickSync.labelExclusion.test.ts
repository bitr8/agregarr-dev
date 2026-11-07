import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  plex: { collectionConfigs: [] as unknown[] },
}));

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/entity/CollectionMissingItems', () => ({
  CollectionMissingItems: class {},
}));
vi.mock('@server/entity/ComingSoonItem', () => ({ ComingSoonItem: class {} }));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', () => ({ getSettings: () => settings }));
vi.mock('@server/lib/collectionsSync', () => ({
  default: { status: { running: false, pending: false } },
}));

import collectionsQuickSync from './collectionsQuickSync';

type Match = {
  plexItem: { ratingKey: string };
  missingItem: { id: number; configId: string };
};

const match = (id: number, ratingKey: string): Match => ({
  plexItem: { ratingKey },
  missingItem: { id, configId: 'cfg-1' },
});

const filter = (matches: Match[], plexClient: unknown) =>
  (
    collectionsQuickSync as unknown as {
      filterExcludedItems: (
        matches: Match[],
        plexClient: unknown,
        cache: Map<string, Set<string>>
      ) => Promise<{ kept: Match[]; collectionExcluded: Match[] }>;
    }
  ).filterExcludedItems(matches, plexClient, new Map());

const ids = (matches: Match[]) => matches.map((m) => m.missingItem.id);

const setConfig = (extra: Record<string, unknown>) => {
  settings.plex.collectionConfigs = [
    { id: 'cfg-1', name: 'Test', libraryId: 'L1', ...extra },
    { id: 'other', name: 'Other', libraryId: 'L1', collectionRatingKey: 'oc' },
  ];
};

const matches = [match(1, 'a'), match(2, 'b'), match(3, 'c')];

describe('collectionsQuickSync.filterExcludedItems label exclusion', () => {
  beforeEach(() => {
    settings.plex.collectionConfigs = [];
  });

  it('drops labelled matches but does not flag them for row cleanup', async () => {
    setConfig({ excludeLabels: ['Placeholder'] });
    const plexClient = {
      getRatingKeysWithLabel: vi.fn(async () => new Set(['b'])),
    };

    const result = await filter(matches, plexClient);

    expect(ids(result.kept)).toEqual([1, 3]);
    expect(result.collectionExcluded).toEqual([]);
    expect(plexClient.getRatingKeysWithLabel).toHaveBeenCalledWith(
      'L1',
      'Placeholder'
    );
  });

  it('flags collection-excluded matches for cleanup and keeps label-excluded ones out of that set', async () => {
    setConfig({
      excludeLabels: ['Placeholder'],
      excludeFromCollections: ['other'],
    });
    const plexClient = {
      getRatingKeysWithLabel: vi.fn(async () => new Set(['b'])),
      getCollectionItems: vi.fn(async () => ['c']),
    };

    const result = await filter(matches, plexClient);

    expect(ids(result.kept)).toEqual([1]);
    expect(ids(result.collectionExcluded)).toEqual([3]);
  });

  it('still applies collection exclusion when the label lookup fails', async () => {
    setConfig({
      excludeLabels: ['Placeholder'],
      excludeFromCollections: ['other'],
    });
    const plexClient = {
      getRatingKeysWithLabel: vi.fn().mockRejectedValue(new Error('boom')),
      getCollectionItems: vi.fn(async () => ['c']),
    };

    const result = await filter(matches, plexClient);

    expect(ids(result.kept)).toEqual([1, 2]);
    expect(ids(result.collectionExcluded)).toEqual([3]);
  });

  it('makes no label call and changes nothing when no labels are set', async () => {
    setConfig({});
    const plexClient = { getRatingKeysWithLabel: vi.fn() };

    const result = await filter(matches, plexClient);

    expect(result.kept).toEqual(matches);
    expect(plexClient.getRatingKeysWithLabel).not.toHaveBeenCalled();
  });

  it('looks each label up once across several collection groups in a run', async () => {
    setConfig({ excludeLabels: ['Placeholder'] });
    const plexClient = {
      getRatingKeysWithLabel: vi.fn(async () => new Set(['b'])),
    };
    const cache = new Map<string, Set<string>>();
    const run = () =>
      (
        collectionsQuickSync as unknown as {
          filterExcludedItems: (
            m: Match[],
            c: unknown,
            cache: Map<string, Set<string>>
          ) => Promise<{ kept: Match[] }>;
        }
      ).filterExcludedItems(matches, plexClient, cache);

    await run();
    const second = await run();

    expect(plexClient.getRatingKeysWithLabel).toHaveBeenCalledTimes(1);
    expect(ids(second.kept)).toEqual([1, 3]);
  });
});

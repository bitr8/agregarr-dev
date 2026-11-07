import { BaseCollectionSync } from '@server/lib/collections/core/BaseCollectionSync';
import type {
  CollectionConfig,
  MultiSourceCollectionConfig,
  SourceDefinition,
} from '@server/lib/settings';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/lib/posterStorage', () => ({ generatePoster: vi.fn() }));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', async () => {
  const actual = await vi.importActual<object>('@server/lib/settings');
  return {
    ...actual,
    getSettings: () => ({
      plex: { libraries: [{ key: '4', type: 'movie' }], collectionConfigs: [] },
      globalExclusions: { movies: [], shows: [] },
      save: vi.fn(),
    }),
  };
});

import { buildMultiSourceSyncConfig } from './CollectionSyncService';
import { MultiSourceOrchestrator } from './MultiSourceOrchestrator';

const filtersA = {
  filterGroups: [
    {
      id: 'g1',
      operator: 'and' as const,
      filters: [
        {
          id: 'f1',
          field: 'with_genres',
          operator: 'and' as const,
          value: '28',
        },
      ],
    },
  ],
};
const filtersB = {
  filterGroups: [
    {
      id: 'g2',
      operator: 'and' as const,
      filters: [
        {
          id: 'f2',
          field: 'vote_average.gte',
          operator: 'and' as const,
          value: 8,
        },
      ],
    },
  ],
};

const parent = {
  id: 'multi-1',
  name: 'Mixed',
  type: 'multi-source',
  libraryId: '4',
  libraryName: 'Movies',
  maxItems: 50,
  template: '',
  isActive: true,
  visibilityConfig: {
    usersHome: true,
    serverOwnerHome: true,
    libraryRecommended: false,
  },
  combineMode: 'list_order',
  sources: [],
} as unknown as MultiSourceCollectionConfig;

const LooseSyncBase = BaseCollectionSync as unknown as new (
  type: string
) => object;

class CapturingSync extends LooseSyncBase {
  public seen: CollectionConfig[] = [];
  constructor() {
    super('tmdb');
  }
  async fetchSourceData(config: CollectionConfig): Promise<unknown[]> {
    this.seen.push(config);
    return [];
  }
  mapSourceDataToItems() {
    return { items: [], missingItems: [] };
  }
}

describe('multi-source TMDB custom advanced filters', () => {
  it('each advanced source fetches with its own filters', async () => {
    const sync = new CapturingSync();
    const orchestrator = new MultiSourceOrchestrator() as unknown as {
      getSyncService: () => BaseCollectionSync<'tmdb'>;
      fetchItemsFromSource: (
        source: SourceDefinition,
        parent: MultiSourceCollectionConfig,
        plexClient: unknown
      ) => Promise<unknown>;
    };
    orchestrator.getSyncService = () =>
      sync as unknown as BaseCollectionSync<'tmdb'>;

    const sources: SourceDefinition[] = [
      {
        id: 's1',
        type: 'tmdb',
        subtype: 'advanced_custom_tmdb',
        priority: 0,
        tmdbAdvancedFilters: filtersA,
      },
      {
        id: 's2',
        type: 'tmdb',
        subtype: 'advanced_custom_tmdb',
        priority: 1,
        tmdbAdvancedFilters: filtersB,
      },
    ];
    const config = buildMultiSourceSyncConfig({
      ...parent,
      sources,
    } as unknown as CollectionConfig);

    for (const source of config.sources) {
      await orchestrator
        .fetchItemsFromSource(source, config, {})
        .catch(() => undefined);
    }

    expect(sync.seen.map((c) => c.tmdbAdvancedFilters)).toEqual([
      filtersA,
      filtersB,
    ]);
  });

  it('non-advanced tmdb sources do not inherit parent-level filters', () => {
    const orchestrator = new MultiSourceOrchestrator() as unknown as {
      createTempConfig: (
        s: SourceDefinition,
        p: MultiSourceCollectionConfig
      ) => CollectionConfig;
    };
    const parentWithFilters = {
      ...parent,
      tmdbAdvancedFilters: filtersA,
    } as unknown as MultiSourceCollectionConfig;
    const temp = orchestrator.createTempConfig(
      { id: 's3', type: 'tmdb', subtype: 'popular', priority: 0 },
      parentWithFilters
    );
    expect(temp.tmdbAdvancedFilters).toBeUndefined();
  });

  it('cache keys differ between advanced sources with different filters', () => {
    const sync = new CapturingSync() as unknown as {
      generateCacheKey: (c: CollectionConfig) => string;
    };
    const base = {
      type: 'tmdb',
      subtype: 'advanced_custom_tmdb',
      libraryId: '4',
    };
    const a = sync.generateCacheKey({
      ...base,
      tmdbAdvancedFilters: filtersA,
    } as unknown as CollectionConfig);
    const b = sync.generateCacheKey({
      ...base,
      tmdbAdvancedFilters: filtersB,
    } as unknown as CollectionConfig);
    expect(a).not.toBe(b);
  });

  it('advanced sources ignore leftover parent sort fields', () => {
    const orchestrator = new MultiSourceOrchestrator() as unknown as {
      createTempConfig: (
        s: SourceDefinition,
        p: MultiSourceCollectionConfig
      ) => CollectionConfig;
    };
    const temp = orchestrator.createTempConfig(
      {
        id: 's4',
        type: 'tmdb',
        subtype: 'advanced_custom_tmdb',
        priority: 0,
        tmdbAdvancedFilters: filtersA,
      },
      {
        ...parent,
        tmdbMovieSortBy: 'revenue.desc',
        tmdbTvSortBy: 'vote_average.desc',
      } as unknown as MultiSourceCollectionConfig
    );
    expect(temp.tmdbMovieSortBy).toBeUndefined();
    expect(temp.tmdbTvSortBy).toBeUndefined();
    expect(temp.tmdbAdvancedFilters).toEqual(filtersA);
  });
});

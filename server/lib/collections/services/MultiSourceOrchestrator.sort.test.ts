import type { CollectionItem } from '@server/lib/collections/core/types';
import type { MultiSourceCollectionConfig } from '@server/lib/settings';
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
      plex: { collectionConfigs: [] },
      globalExclusions: { movies: [], shows: [] },
      save: vi.fn(),
    }),
  };
});
vi.mock('@server/lib/collections/core/CollectionUtilities', async () => {
  const actual = await vi.importActual<object>(
    '@server/lib/collections/core/CollectionUtilities'
  );
  return {
    ...actual,
    applyCollectionExclusions: async (items: unknown[]) => items,
    validateAndSanitizeItems: (items: unknown[]) => ({
      validItems: items,
      invalidItems: [],
      validationErrors: [],
    }),
  };
});

import { BaseCollectionSync } from '@server/lib/collections/core/BaseCollectionSync';
import { MultiSourceOrchestrator } from './MultiSourceOrchestrator';

const POSITIONS = [2, 1, 3];

class TestSync extends BaseCollectionSync<'tmdb'> {
  constructor() {
    super('tmdb');
  }
  protected async validateConfiguration(): Promise<void> {
    return;
  }
  protected async processConfiguration(): Promise<never> {
    throw new Error('unused');
  }
  protected async createTemplateContext(): Promise<never> {
    throw new Error('unused');
  }
  protected async createCollection(): Promise<never> {
    throw new Error('unused');
  }
  async fetchSourceData(): Promise<never[]> {
    return [];
  }
  async mapSourceDataToItems(_d: unknown, c: { id: string }) {
    const dates = c.id.endsWith('s1') ? [10, 20, 100] : [30];
    return {
      items: dates.map((d, i) => ({
        ...item(`${c.id}-${d}`, d),
        metadata: { originalPosition: POSITIONS[i] },
      })),
    };
  }
}

const item = (title: string, addedAt: number): CollectionItem =>
  ({ title, addedAt, type: 'movie', ratingKey: title } as CollectionItem);

async function run(sortOrder?: string, realFetch = false): Promise<string[]> {
  const orchestrator = new MultiSourceOrchestrator() as unknown as Record<
    string,
    unknown
  > & { processMultiSourceCollection: (...a: unknown[]) => Promise<unknown> };
  const groups = [
    [item('a1', 10), item('a2', 30)],
    [item('b1', 20), item('b2', 40)],
  ];
  let call = 0;
  let captured: CollectionItem[] = [];
  if (!realFetch) {
    orchestrator.fetchItemsFromSource = async () => ({ items: groups[call++] });
  }
  orchestrator.getSyncService = () => new TestSync();
  orchestrator.createOrUpdatePlexCollection = async (
    items: CollectionItem[]
  ) => {
    captured = items;
    return { created: 0, updated: 0 };
  };
  const config = {
    id: 'ms1',
    name: 'ms',
    type: 'multi-source',
    libraryId: '1',
    libraryName: 'Movies',
    maxItems: realFetch ? 2 : 50,
    isActive: true,
    visibilityConfig: {},
    combineMode: 'list_order',
    sources: [
      { id: 's1', type: 'tmdb', subtype: '', priority: 1 },
      { id: 's2', type: 'tmdb', subtype: '', priority: 2 },
    ],
    ...(sortOrder && { sortOrder }),
  } as unknown as MultiSourceCollectionConfig;
  await orchestrator.processMultiSourceCollection(config, {}, []);
  return captured.map((i) => i.title);
}

describe('multi-source Item Order', () => {
  it('unset keeps the combined order', async () => {
    expect(await run()).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it("'default' keeps the combined order", async () => {
    expect(await run('default')).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it('sorts the whole combined list', async () => {
    expect(await run('date_added_desc')).toEqual(['b2', 'a2', 'b1', 'a1']);
  });

  it('reverse reverses each source then combines', async () => {
    expect(await run('reverse', true)).toEqual(['ms1-s1-100', 'ms1-s1-10']);
  });

  it('default keeps the first items by source position', async () => {
    expect(await run('default', true)).toEqual(['ms1-s1-20', 'ms1-s1-10']);
  });

  it('sorts each source before the maxItems cut', async () => {
    expect(await run('date_added_desc', true)).toEqual([
      'ms1-s1-100',
      'ms1-s2-30',
    ]);
  });
});

describe('opt-out and Coming Soon', () => {
  it('does not order the combined list when unset or default', async () => {
    const spy = vi.spyOn(TestSync.prototype, 'orderCombinedItems');
    await run();
    await run('default');
    expect(spy).not.toHaveBeenCalled();
    await run('date_added_desc');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('orders Coming Soon items by releaseDateSortValue', async () => {
    const cs = (t: string, d: string) =>
      ({ ...item(t, 0), releaseDateSortValue: d } as CollectionItem);
    const out = await new TestSync().orderCombinedItems(
      [cs('old', '2026-01-01'), cs('new', '2026-06-01')],
      { sortOrder: 'release_date_desc' } as never
    );
    expect(out.map((i) => i.title)).toEqual(['new', 'old']);
  });
});

describe('orderItems enrichment', () => {
  const enrich = vi.fn(async (items: CollectionItem[]) => items);
  class Spy extends TestSync {
    protected async enrichItemsWithImdbRatings(items: CollectionItem[]) {
      return enrich(items);
    }
  }
  const cfg = (sortOrder: string) => ({ sortOrder } as never);

  it('fetches IMDb ratings only for IMDb sorts', async () => {
    enrich.mockClear();
    await new Spy().orderItems([item('x', 1)], cfg('date_added_desc'));
    expect(enrich).not.toHaveBeenCalled();
    await new Spy().orderItems([item('x', 1)], cfg('imdb_rating_desc'));
    expect(enrich).toHaveBeenCalledTimes(1);
  });

  it('skips the fetch when already enriched', async () => {
    enrich.mockClear();
    await new Spy().orderItems([item('x', 1)], cfg('imdb_rating_desc'), true);
    expect(enrich).not.toHaveBeenCalled();
  });
});

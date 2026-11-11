import type { CollectionItem } from '@server/lib/collections/core/types';
import { describe, expect, it, vi } from 'vitest';

const captured: { items: CollectionItem[] } = { items: [] };
const sync = vi.hoisted(() => ({ instance: undefined as unknown }));

vi.mock('@server/api/plexapi', () => ({ default: class {} }));
vi.mock('@server/api/themoviedb', () => ({ default: class {} }));
vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/entity/User', () => ({ User: class {} }));
vi.mock('@server/middleware/auth', () => ({
  isAuthenticated: () => (_a: unknown, _b: unknown, next: () => void) => next(),
}));
vi.mock('./collections', () => ({ validateExternalUrl: vi.fn() }));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/collections/services/LibraryCacheService', () => ({
  libraryCacheService: {},
}));
vi.mock('@server/lib/collections/services/CollectionSyncService', () => ({
  collectionSyncService: { createSyncService: async () => sync.instance },
}));
vi.mock('@server/lib/collections/core/CollectionUtilities', async () => {
  const actual = await vi.importActual<object>(
    '@server/lib/collections/core/CollectionUtilities'
  );
  return {
    ...actual,
    capPreviewItemsToMaxItems: (items: CollectionItem[]) => {
      captured.items = items;
      throw new Error('stop');
    },
  };
});

import { BaseCollectionSync } from '@server/lib/collections/core/BaseCollectionSync';
import { processMultiSourcePreview } from './collections-preview';

const item = (title: string, addedAt: number): CollectionItem =>
  ({ title, addedAt, type: 'movie', ratingKey: title } as CollectionItem);

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
  async fetchSourceDataWithCache(): Promise<never[]> {
    return [{}] as never[];
  }
  async mapSourceDataToItems(_d: unknown, c: { id: string }) {
    return {
      items:
        c.id === 'preview-s1'
          ? [item('a1', 10), item('a2', 30)]
          : [item('b1', 20), item('b2', 40)],
    };
  }
}

async function run(
  sortOrder?: 'date_added_desc' | 'reverse'
): Promise<string[]> {
  sync.instance = new TestSync();
  captured.items = [];
  await processMultiSourcePreview(
    'sid',
    [
      { id: 's1', type: 'tmdb', priority: 1 },
      { id: 's2', type: 'tmdb', priority: 2 },
    ],
    'list_order',
    sortOrder,
    50,
    '1',
    'Movies',
    'movie',
    {} as never,
    {} as never,
    0
  ).catch(() => undefined);
  return captured.items.map((i) => i.title);
}

describe('multi-source preview Item Order', () => {
  it('unset keeps the combined order', async () => {
    expect(await run()).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it('sorts the combined list like sync does', async () => {
    expect(await run('date_added_desc')).toEqual(['b2', 'a2', 'b1', 'a1']);
  });

  it('reverse reverses each source then combines', async () => {
    expect(await run('reverse')).toEqual(['a2', 'a1', 'b2', 'b1']);
  });
});

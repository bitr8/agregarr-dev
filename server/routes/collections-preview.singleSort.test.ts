import type { CollectionItem } from '@server/lib/collections/core/types';
import { describe, expect, it, vi } from 'vitest';

const captured: { items: CollectionItem[] } = { items: [] };
const sync = vi.hoisted(() => ({ instance: undefined as unknown }));

vi.mock('@server/api/plexapi', () => ({
  default: class {
    async getLibraries() {
      return [{ key: '1', title: 'Movies', type: 'movie' }];
    }
  },
}));
vi.mock('@server/api/themoviedb', () => ({ default: class {} }));
vi.mock('@server/datasource', () => ({
  getRepository: () => ({
    findOne: async () => ({ id: 1, plexToken: 't' }),
  }),
}));
vi.mock('@server/entity/User', () => ({ User: class {} }));
vi.mock('@server/middleware/auth', () => ({
  isAuthenticated: () => (_a: unknown, _b: unknown, next: () => void) => next(),
}));
vi.mock('./collections', () => ({ validateExternalUrl: vi.fn() }));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/collections/services/LibraryCacheService', () => ({
  libraryCacheService: { getCache: async () => ({}) },
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
import { processPreviewAsync } from './collections-preview';

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
  async mapSourceDataToItems() {
    return { items: [item('a', 10), item('b', 30), item('c', 20)] };
  }
}

async function run(sortOrder?: 'date_added_desc'): Promise<string[]> {
  sync.instance = new TestSync();
  captured.items = [];
  await processPreviewAsync('sid', {
    type: 'tmdb',
    libraryId: '1',
    sortOrder,
  } as never).catch(() => undefined);
  return captured.items.map((i) => i.title);
}

describe('single-source preview Item Order', () => {
  it('unset keeps the source order', async () => {
    expect(await run()).toEqual(['a', 'b', 'c']);
  });

  it('applies sortOrder like sync does', async () => {
    expect(await run('date_added_desc')).toEqual(['b', 'c', 'a']);
  });
});

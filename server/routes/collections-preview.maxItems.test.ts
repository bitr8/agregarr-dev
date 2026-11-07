import type { CollectionItem } from '@server/lib/collections/core/types';
import { describe, expect, it, vi } from 'vitest';

const captured: { items: CollectionItem[] } = { items: [] };
const seen: { id: string; maxItems?: number }[] = [];
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

const LooseSyncBase = BaseCollectionSync as unknown as new (
  type: string
) => object;

class TestSync extends LooseSyncBase {
  constructor() {
    super('tmdb');
  }
  async fetchSourceDataWithCache(c: {
    id: string;
    maxItems?: number;
  }): Promise<unknown[]> {
    seen.push({ id: c.id, maxItems: c.maxItems });
    return [];
  }
}

describe('multi-source preview per-source maxItems', () => {
  it('bounds advanced sources by the collection limit, leaves others unbounded', async () => {
    sync.instance = new TestSync();
    await processMultiSourcePreview(
      'sid',
      [
        {
          id: 's1',
          type: 'tmdb',
          subtype: 'advanced_custom_tmdb',
          priority: 1,
        },
        { id: 's2', type: 'tmdb', subtype: 'popular', priority: 2 },
      ],
      'list_order',
      undefined,
      7,
      '1',
      'Movies',
      'movie',
      {} as never,
      {} as never,
      0
    ).catch(() => undefined);
    expect(seen).toEqual([
      { id: 'preview-s1', maxItems: 7 },
      { id: 'preview-s2', maxItems: 0 },
    ]);
  });
});

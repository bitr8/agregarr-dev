import { BaseCollectionSync } from '@server/lib/collections/core/BaseCollectionSync';
import express from 'express';
import type { AddressInfo } from 'net';
import { describe, expect, it, vi } from 'vitest';
import router, { processMultiSourcePreview } from './collections-preview';

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
    );
    expect(seen).toEqual([
      { id: 'preview-s1', maxItems: 7 },
      { id: 'preview-s2', maxItems: 0 },
    ]);
  });
});

it('reports the failed anime source in the preview status and continues to the next source', async () => {
  seen.length = 0;
  sync.instance = new TestSync();
  await processMultiSourcePreview(
    'partial',
    [
      { id: 'anime-list', type: 'anilist', priority: 1 },
      { id: 'movie-list', type: 'tmdb', priority: 2 },
    ],
    'list_order',
    undefined,
    7,
    '1',
    'Movies',
    'movie',
    {} as never,
    {},
    0
  );
  const app = express();
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/status/partial`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      completed: true,
      result: {
        sourceErrors: [
          {
            sourceId: 'anime-list',
            sourceName: expect.stringMatching(/anilist/i),
            message: 'Plex library 1 is missing from the library cache',
          },
        ],
      },
    });
    expect(seen.map((source) => source.id)).toEqual(['preview-movie-list']);
  } finally {
    server.close();
  }
});

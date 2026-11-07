import type { PlexAPI } from '@server/api/plexapi';
import type { CollectionItem } from '@server/lib/collections/core/types';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/entity/User', () => ({ User: class {} }));
vi.mock('@server/lib/collections/utils/TemplateEngine', () => ({
  templateEngine: {},
}));
vi.mock('@server/logger', () => ({
  default: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({ plex: { collectionConfigs: [] }, save: vi.fn() }),
}));

import { applyCollectionExclusions } from '@server/lib/collections/core/CollectionUtilities';

const item = (ratingKey: string): CollectionItem => ({
  ratingKey,
  title: `Item ${ratingKey}`,
  type: 'movie',
});

const items = [item('a1'), item('a2'), item('a3')];

const makeClient = (byLibrary: Record<string, Record<string, string[]>>) => {
  const getRatingKeysWithLabel = vi.fn(
    async (library: string, label: string) =>
      new Set(byLibrary[library]?.[label.toLowerCase()] ?? [])
  );
  return {
    client: { getRatingKeysWithLabel } as unknown as PlexAPI,
    getRatingKeysWithLabel,
  };
};

describe('applyCollectionExclusions label exclusion', () => {
  it('drops items carrying an excluded label and keeps the rest', async () => {
    const { client } = makeClient({ L1: { 'some-label': ['a2'] } });
    const result = await applyCollectionExclusions(
      items,
      { name: 'Test', libraryId: 'L1', excludeLabels: ['Some-Label'] },
      client,
      'imdb'
    );
    expect(result.map((i) => i.ratingKey)).toEqual(['a1', 'a3']);
  });

  it('unions several labels and every library of a multi-library config', async () => {
    const { client } = makeClient({
      L1: { one: ['a1'] },
      L2: { two: ['a3'] },
    });
    const result = await applyCollectionExclusions(
      items,
      { name: 'Test', libraryId: ['L1', 'L2'], excludeLabels: ['one', 'two'] },
      client,
      'imdb'
    );
    expect(result.map((i) => i.ratingKey)).toEqual(['a2']);
  });

  it('leaves items untouched and makes no Plex call when no labels are set', async () => {
    const { client, getRatingKeysWithLabel } = makeClient({});
    for (const excludeLabels of [undefined, [], ['  ']]) {
      const result = await applyCollectionExclusions(
        items,
        { name: 'Test', libraryId: 'L1', excludeLabels },
        client,
        'imdb'
      );
      expect(result).toBe(items);
    }
    expect(getRatingKeysWithLabel).not.toHaveBeenCalled();
  });

  it('keeps all items when the Plex lookup fails', async () => {
    const client = {
      getRatingKeysWithLabel: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as PlexAPI;
    const result = await applyCollectionExclusions(
      items,
      { name: 'Test', libraryId: 'L1', excludeLabels: ['x'] },
      client,
      'imdb'
    );
    expect(result).toBe(items);
  });
});

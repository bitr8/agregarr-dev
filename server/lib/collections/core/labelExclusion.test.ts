import type PlexAPI from '@server/api/plexapi';
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
const settings = vi.hoisted(() => ({
  plex: { collectionConfigs: [] as Record<string, unknown>[] },
  save: () => undefined,
}));
vi.mock('@server/lib/settings', () => ({ getSettings: () => settings }));

import { applyLabelExclusions } from '@server/lib/collections/core/CollectionUtilities';

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

describe('applyLabelExclusions', () => {
  it('drops items carrying an excluded label and keeps the rest', async () => {
    const { client } = makeClient({ L1: { 'some-label': ['a2'] } });
    const result = await applyLabelExclusions(
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
    const result = await applyLabelExclusions(
      items,
      {
        name: 'Test',
        libraryId: ['L1', 'L2'] as unknown as string,
        excludeLabels: ['one', 'two'],
      },
      client,
      'imdb'
    );
    expect(result.map((i) => i.ratingKey)).toEqual(['a2']);
  });

  it('leaves items untouched and makes no Plex call when no labels are set', async () => {
    const { client, getRatingKeysWithLabel } = makeClient({});
    for (const excludeLabels of [undefined, [], ['  ']]) {
      const result = await applyLabelExclusions(
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
    const result = await applyLabelExclusions(
      items,
      { name: 'Test', libraryId: 'L1', excludeLabels: ['x'] },
      client,
      'imdb'
    );
    expect(result).toBe(items);
  });

  describe('emptying the existing collection', () => {
    const emptyingClient = (
      byLibrary: Record<string, Record<string, string[]>>
    ) => {
      const { client, getRatingKeysWithLabel } = makeClient(byLibrary);
      const updateCollectionContents = vi.fn(async () => ({
        added: 0,
        removed: 2,
        removedKeys: ['a1', 'a2'],
        reordered: false,
        errors: [],
      }));
      const addLabelToItem = vi.fn(async () => undefined);
      return {
        client: Object.assign(client, {
          updateCollectionContents,
          addLabelToItem,
        }) as unknown as PlexAPI,
        getRatingKeysWithLabel,
        updateCollectionContents,
        addLabelToItem,
      };
    };
    const all = { 'some-label': ['a1', 'a2', 'a3'] };

    it('removes members and marks them stale when labels exclude every item', async () => {
      const { client, updateCollectionContents, addLabelToItem } =
        emptyingClient({ L1: all });
      const result = await applyLabelExclusions(
        items,
        {
          name: 'Test',
          libraryId: 'L1',
          excludeLabels: ['some-label'],
          collectionRatingKey: 'c1',
          type: 'imdb',
        },
        client,
        'imdb'
      );
      expect(result).toEqual([]);
      expect(updateCollectionContents).toHaveBeenCalledWith('c1', [], 'Test');
      expect(addLabelToItem).toHaveBeenCalledWith('a1', 'agregarr-stale');
      expect(addLabelToItem).toHaveBeenCalledWith('a2', 'agregarr-stale');
    });

    it('leaves the collection alone when items remain, the list was already empty, or there is no stored collection', async () => {
      const partial = emptyingClient({ L1: { 'some-label': ['a1'] } });
      await applyLabelExclusions(
        items,
        {
          name: 'Test',
          libraryId: 'L1',
          excludeLabels: ['some-label'],
          collectionRatingKey: 'c1',
          type: 'imdb',
        },
        partial.client,
        'imdb'
      );
      const emptyIn = emptyingClient({ L1: all });
      await applyLabelExclusions(
        [],
        {
          name: 'Test',
          libraryId: 'L1',
          excludeLabels: ['some-label'],
          collectionRatingKey: 'c1',
          type: 'imdb',
        },
        emptyIn.client,
        'imdb'
      );
      const noKey = emptyingClient({ L1: all });
      await applyLabelExclusions(
        items,
        { name: 'Test', libraryId: 'L1', excludeLabels: ['some-label'] },
        noKey.client,
        'imdb'
      );
      expect(partial.updateCollectionContents).not.toHaveBeenCalled();
      expect(emptyIn.updateCollectionContents).not.toHaveBeenCalled();
      expect(noKey.updateCollectionContents).not.toHaveBeenCalled();
    });

    it('clears the stored key once the collection has been emptied, and when Plex no longer has it', async () => {
      const stored = () =>
        settings.plex.collectionConfigs[0].collectionRatingKey;
      const base = {
        name: 'Test',
        id: 'cfg-1',
        libraryId: 'L1',
        excludeLabels: ['some-label'],
        collectionRatingKey: 'c1',
        type: 'imdb' as const,
      };

      settings.plex.collectionConfigs = [
        { id: 'cfg-1', libraryId: 'L1', collectionRatingKey: 'c1' },
      ];
      const removed = emptyingClient({ L1: all });
      await applyLabelExclusions(items, base, removed.client, 'imdb');
      expect(stored()).toBeUndefined();

      settings.plex.collectionConfigs = [
        { id: 'cfg-1', libraryId: 'L1', collectionRatingKey: 'c1' },
      ];
      const vanished = emptyingClient({ L1: all });
      vanished.updateCollectionContents.mockResolvedValue({
        added: 0,
        removed: 0,
        removedKeys: [],
        reordered: false,
        errors: [],
      });
      (
        vanished.client as unknown as { getCollectionMetadata: unknown }
      ).getCollectionMetadata = vi.fn(async () => null);
      await applyLabelExclusions(items, base, vanished.client, 'imdb');
      expect(stored()).toBeUndefined();

      settings.plex.collectionConfigs = [
        { id: 'cfg-1', libraryId: 'L1', collectionRatingKey: 'c1' },
      ];
      const present = emptyingClient({ L1: all });
      present.updateCollectionContents.mockResolvedValue({
        added: 0,
        removed: 0,
        removedKeys: [],
        reordered: false,
        errors: [],
      });
      (
        present.client as unknown as { getCollectionMetadata: unknown }
      ).getCollectionMetadata = vi.fn(async () => ({ ratingKey: 'c1' }));
      await applyLabelExclusions(items, base, present.client, 'imdb');
      expect(stored()).toBe('c1');
    });
  });
});

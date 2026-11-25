import type { CollectionConfig } from '@server/lib/settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/entity/User', () => ({ User: class {} }));
vi.mock('@server/lib/collections/utils/TemplateEngine', () => ({
  templateEngine: {},
}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const settings = {
  plex: { collectionConfigs: [] as CollectionConfig[] },
  save: vi.fn(),
};
vi.mock('@server/lib/settings', () => ({ getSettings: () => settings }));

import {
  getCollectionSyncCounter,
  incrementCollectionSyncCounter,
} from './CollectionUtilities';

const seed = (syncCounter?: number) => {
  settings.plex.collectionConfigs = [
    {
      id: 'c1',
      name: 'Mix',
      ...(syncCounter !== undefined && { syncCounter }),
    },
  ] as unknown as CollectionConfig[];
};

// Mirrors the orchestrator: advance, then read the active index.
const sync = (sources: number) => {
  incrementCollectionSyncCounter('c1');
  return getCollectionSyncCounter('c1') % sources;
};

describe('cycle lists position', () => {
  beforeEach(() => seed());

  it('shows the first list on the first sync, then each list in turn', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(() => sync(3))).toEqual([
      0, 1, 2, 0, 1, 2, 0,
    ]);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 11])(
    'carries on from a stored counter of %i exactly as before',
    (stored) => {
      seed(stored);
      const sources = 3;
      const before = [0, 1, 2, 3].map((i) => (stored + 1 + i) % sources);
      const after = [0, 1, 2, 3].map(() => sync(sources));
      expect(after).toEqual(before);
    }
  );
});

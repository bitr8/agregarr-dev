import type PlexAPI from '@server/api/plexapi';
import type { CollectionConfig } from '@server/lib/settings';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/entity/ComingSoonItem', () => ({ ComingSoonItem: class {} }));
vi.mock('@server/entity/CollectionMetadata', () => ({
  CollectionMetadata: class {},
}));
vi.mock('@server/entity/CollectionMissingItems', () => ({
  CollectionMissingItems: class {},
}));
vi.mock('@server/entity/PosterTemplate', () => ({ PosterTemplate: class {} }));
vi.mock('@server/entity/User', () => ({ User: class {} }));
vi.mock('@server/api/imdbRatings', () => ({ default: class {} }));
vi.mock('@server/lib/cache', () => ({ default: { getCache: vi.fn() } }));
vi.mock('@server/lib/posterStorage', () => ({ generatePoster: vi.fn() }));
vi.mock('@server/lib/collections/services/ServiceUserManager', () => ({
  serviceUserManager: {},
}));
vi.mock('@server/lib/collections/utils/TemplateEngine', () => ({
  templateEngine: { processTemplate: (t: string) => t },
}));
vi.mock('@server/lib/collections/utils/CollectionExclusionUtils', () => ({
  applyCollectionExclusions: async (items: unknown[]) => items,
}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    globalExclusions: { movies: [], tv: [], tvdb: [], tmdb: [] },
    plex: {
      collectionConfigs: [],
      libraries: [{ key: '1', name: 'Movies', type: 'movie' }],
    },
  }),
}));

import type { CollectionItem } from '@server/lib/collections/core/types';
import { ComingSoonCollectionSync } from './comingsoon';

const source = (tmdbId: number, releaseDate: string, extra = {}) => ({
  tmdbId,
  title: `T${tmdbId}`,
  mediaType: 'movie' as const,
  source: 'trakt' as const,
  monitored: false,
  releaseDate,
  ...extra,
});

const item = (tmdbId: number): CollectionItem =>
  ({
    ratingKey: `rk${tmdbId}`,
    title: `T${tmdbId}`,
    type: 'movie',
    tmdbId,
  } as CollectionItem);

const run = async (
  sortOrder?: CollectionConfig['sortOrder'],
  opts: { realFiltering?: boolean; maxItems?: number } = {}
) => {
  const sync = new ComingSoonCollectionSync();
  // Trakt rank: 1, 2, 3, 4. Release dates run the opposite way.
  const sourceData = [
    source(1, '2027-04-01'),
    source(2, '2027-03-01'),
    source(3, '2027-02-01'),
    source(4, '2027-01-01'),
  ];
  const created = vi.fn(async () => ({
    created: 1,
    updated: 0,
    collectionRatingKey: 'c1',
  }));
  const s = sync as never as Record<string, unknown>;
  s.fetchSourceData = async () => sourceData;
  s.mapSourceDataToItems = async () => ({
    items: opts.realFiltering
      ? [item(4), item(3), item(2), item(1)]
      : [item(3), item(1)],
    missingItems: [],
    placeholderItems: [],
  });
  if (!opts.realFiltering) {
    s.applyFilteringToMappedItems = async (m: { items: CollectionItem[] }) => ({
      items: m.items,
      missingItems: [],
    });
  }
  s.tagExistingItemsInArr = async () => undefined;
  // placeholders: rank 4 and rank 2 are placeholders
  s.handlePlaceholdersAndMissingItems = async () =>
    opts.realFiltering ? [] : [item(4), item(2)];
  s.generateCollectionNameWithCustom = async () => 'Name';
  s.createCollection = created;
  s.storeCollectionMissingItems = async () => undefined;

  const config = {
    id: 'c',
    name: 'Anticipated',
    type: 'comingsoon',
    subtype: 'trakt_anticipated',
    libraryId: '1',
    mediaType: 'movie',
    sortOrder,
    maxItems: opts.maxItems,
  } as unknown as CollectionConfig;
  await (
    sync as never as {
      processConfiguration: (...a: unknown[]) => Promise<unknown>;
    }
  ).processConfiguration(config, {} as PlexAPI, [], new Set());
  const items = (created.mock.calls[0] as unknown as [CollectionItem[]])[0];
  return items.map((i) => i.tmdbId);
};

describe('Coming Soon trakt_anticipated source rank order', () => {
  it('keeps Trakt rank, placeholders included, with source_rank', async () => {
    expect(await run('source_rank')).toEqual([1, 2, 3, 4]);
  });

  it('still sorts soonest release first by default', async () => {
    expect(await run(undefined)).toEqual([4, 3, 2, 1]);
    expect(await run('default')).toEqual([4, 3, 2, 1]);
  });

  it('trims to maxItems by Trakt rank, not mapping order', async () => {
    expect(
      await run('source_rank', { realFiltering: true, maxItems: 2 })
    ).toEqual([1, 2]);
  });
});

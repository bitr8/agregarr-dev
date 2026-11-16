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
const labels = vi.hoisted(() => ({ excluded: new Set<number>() }));
vi.mock(
  '@server/lib/collections/core/CollectionUtilities',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    applyLabelExclusions: async (items: { tmdbId?: number }[]) =>
      items.filter((i) => !labels.excluded.has(i.tmdbId ?? -1)),
  })
);
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

type Run = {
  maxItems?: number;
  subtype?: string;
  present?: number[];
  missing?: number[];
  creatable?: number[];
  excludedLabel?: number[];
  createPlaceholdersForMissing?: boolean;
  reorderOnly?: boolean;
  extraRows?: number[];
};

// Trakt rank 1..8. Release dates run the opposite way (rank 1 releases last).
const sourceData = [1, 2, 3, 4, 5, 6, 7, 8].map((id) =>
  source(id, `2027-${String(13 - id).padStart(2, '0')}-01`)
);

const harness = async (
  sortOrder: CollectionConfig['sortOrder'] | undefined,
  opts: Run = {}
) => {
  const sync = new ComingSoonCollectionSync();
  const present = opts.present ?? [3, 1];
  const missing = opts.missing ?? [4, 2];
  const creatable = new Set(opts.creatable ?? missing);
  const excluded = new Set(opts.excludedLabel ?? []);
  const created = vi.fn(async () => ({
    created: 1,
    updated: 0,
    collectionRatingKey: 'c1',
  }));
  const attempts: number[][] = [];
  const stored = vi.fn(async () => undefined);
  const cleared = vi.fn(async () => undefined);
  const tagged = vi.fn(async () => undefined);
  const cleanup = vi.fn(async () => undefined);
  const s = sync as never as Record<string, unknown>;
  s.fetchSourceData = async () => sourceData;
  s.mapSourceDataToItems = async () => ({
    items: present.map(item),
    missingItems: [...missing, ...(opts.extraRows ?? [])].map((id, i) => ({
      tmdbId: id,
      title: `T${id}`,
      mediaType: 'movie',
      originalPosition: i + 1,
    })),
    placeholderItems: [],
  });
  s.tagExistingItemsInArr = tagged;
  s.clearCollectionMissingItems = cleared;
  s.cleanupPlaceholders = cleanup;
  s.processMissingItems = async (list: { tmdbId: number }[]) => {
    attempts.push(list.map((m) => m.tmdbId));
    list = list.filter(
      (m, i) => list.findIndex((o) => o.tmdbId === m.tmdbId) === i
    );
    return list
      .filter((m) => creatable.has(m.tmdbId))
      .map((m) => item(m.tmdbId));
  };
  s.generateCollectionNameWithCustom = async () => 'Name';
  s.createCollection = created;
  s.storeCollectionMissingItems = stored;

  const config = {
    id: 'c',
    name: 'Anticipated',
    type: 'comingsoon',
    subtype: opts.subtype ?? 'trakt_anticipated',
    libraryId: '1',
    mediaType: 'movie',
    sortOrder,
    maxItems: opts.maxItems,
    createPlaceholdersForMissing: opts.createPlaceholdersForMissing ?? true,
  } as unknown as CollectionConfig;
  labels.excluded = excluded;
  await (
    sync as never as {
      processConfiguration: (...a: unknown[]) => Promise<unknown>;
    }
  ).processConfiguration(config, {} as PlexAPI, [], new Set(), undefined, {
    reorderOnly: opts.reorderOnly,
  });
  const calls = created.mock.calls as unknown as [CollectionItem[]][];
  return {
    ids: calls.length ? calls[0][0].map((i) => i.tmdbId) : [],
    attempts,
    cleanup,
    cleared,
    taggedIds: (
      (
        tagged.mock.calls[0] as unknown as [CollectionItem[]] | undefined
      )?.[0] ?? []
    ).map((i) => i.tmdbId),
    storedIds: (
      (
        stored.mock.calls[0] as unknown as [{ tmdbId: number }[]] | undefined
      )?.[0] ?? []
    ).map((m) => m.tmdbId),
  };
};
const run = async (sortOrder?: CollectionConfig['sortOrder'], opts: Run = {}) =>
  (await harness(sortOrder, opts)).ids;

describe('Coming Soon trakt_anticipated source rank order', () => {
  it('keeps Trakt rank, placeholders included, with source_rank', async () => {
    expect(await run('source_rank')).toEqual([1, 2, 3, 4]);
  });

  it('still sorts soonest release first by default', async () => {
    expect(await run(undefined)).toEqual([4, 3, 2, 1]);
    expect(await run('default')).toEqual([4, 3, 2, 1]);
  });
});

describe('Coming Soon maxItems covers present items and placeholders together', () => {
  it('never goes over maxItems and keeps the best Trakt ranks', async () => {
    expect(await run('source_rank', { maxItems: 2 })).toEqual([1, 2]);
    expect(await run('default', { maxItems: 3 })).toEqual([3, 2, 1]);
  });

  it('only creates placeholders that fit the window', async () => {
    const r = await harness('source_rank', {
      maxItems: 2,
      present: [1, 3, 5],
      missing: [2, 4, 6],
    });
    expect(r.ids).toEqual([1, 2]);
    expect(r.attempts).toEqual([[2]]);
  });

  it('gives a failed placeholder slot to the next-ranked item', async () => {
    const r = await harness('source_rank', {
      maxItems: 4,
      present: [3],
      missing: [1, 2, 4, 5, 6],
      creatable: [2, 5, 6],
    });
    expect(r.ids).toEqual([2, 3, 5, 6]);
    expect(r.attempts).toEqual([
      [1, 2, 4],
      [5, 6],
    ]);
  });

  it('fills past present items dropped by label exclusions', async () => {
    const r = await harness('source_rank', {
      maxItems: 3,
      present: [1, 2, 3],
      missing: [4, 5, 6],
      excludedLabel: [1, 2],
    });
    expect(r.ids).toEqual([3, 4, 5]);
  });

  it('keeps the soonest releases for subtypes without a ranking', async () => {
    expect(await run('default', { maxItems: 2, subtype: 'monitored' })).toEqual(
      [4, 3]
    );
  });

  it('changes nothing when maxItems is unset or not reached', async () => {
    expect(await run('source_rank', { maxItems: 4 })).toEqual([1, 2, 3, 4]);
    const r = await harness('default', {
      present: [1, 3, 5, 7],
      missing: [2, 4, 6, 8],
    });
    expect(r.ids).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(r.attempts).toEqual([[2, 4, 6, 8]]);
  });

  it('stores only missing items that could still enter a full window', async () => {
    const r = await harness('source_rank', {
      maxItems: 2,
      present: [2, 3],
      missing: [1, 4],
      creatable: [],
    });
    expect(r.ids).toEqual([2, 3]);
    expect(r.storedIds).toEqual([1]);
  });

  it('keeps filling after a whole round of placeholders is excluded', async () => {
    const r = await harness('source_rank', {
      maxItems: 2,
      present: [],
      missing: [1, 2, 3, 4],
      excludedLabel: [1, 2],
    });
    expect(r.ids).toEqual([3, 4]);
    expect(r.attempts).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('reaches eligible items past a long run of ineligible ones', async () => {
    const r = await harness('source_rank', {
      maxItems: 2,
      present: [1, 2, 3, 4, 5, 6],
      missing: [7, 8],
      excludedLabel: [1, 2, 3, 4, 5, 6],
    });
    expect(r.ids).toEqual([7, 8]);
  });

  it('falls back to lower-ranked real items when top placeholders all fail', async () => {
    const r = await harness('source_rank', {
      maxItems: 2,
      present: [5, 6],
      missing: [1, 2, 3, 4],
      creatable: [],
    });
    expect(r.ids).toEqual([5, 6]);
    expect(r.attempts).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('protects every source item from cleanup, excluded ones included', async () => {
    const r = await harness('source_rank', {
      maxItems: 1,
      present: [1, 2, 3],
      missing: [4],
      excludedLabel: [1],
    });
    const keepIds = (r.cleanup.mock.calls[0] as unknown[])[3] as Set<number>;
    expect([...keepIds].sort()).toEqual([1, 2, 3, 4]);
  });

  it('keeps going past more failed rounds than any fixed cap', async () => {
    const r = await harness('source_rank', {
      maxItems: 1,
      present: [],
      missing: [1, 2, 3, 4, 5, 6, 7, 8],
      creatable: [8],
    });
    expect(r.ids).toEqual([8]);
    expect(r.attempts).toHaveLength(8);
  });

  it('keeps a Quick Sync row for the worst-ranked new placeholder', async () => {
    const r = await harness('source_rank', {
      maxItems: 2,
      present: [1],
      missing: [2, 3],
    });
    expect(r.ids).toEqual([1, 2]);
    expect(r.storedIds).toEqual([2]);
  });

  it('counts a show with several missing season rows once', async () => {
    const r = await harness('source_rank', {
      maxItems: 2,
      present: [],
      missing: [1, 2],
      extraRows: [1, 1],
    });
    expect(r.ids).toEqual([1, 2]);
    expect(r.attempts).toEqual([[1, 1, 1, 2]]);
  });

  it('clears old Quick Sync rows when nothing missing can enter', async () => {
    const r = await harness('source_rank', {
      maxItems: 2,
      present: [1, 2],
      missing: [3],
    });
    expect(r.storedIds).toEqual([]);
    expect(r.cleared).toHaveBeenCalledWith('c1');
  });

  it('tags the present items the old trim kept, before exclusions', async () => {
    const r = await harness('source_rank', {
      maxItems: 2,
      present: [3, 1, 2],
      missing: [],
      excludedLabel: [1],
    });
    expect(r.taggedIds).toEqual([1, 2]);
    expect(r.ids).toEqual([2, 3]);
    const fits = await harness('default', { present: [3, 1], missing: [] });
    expect(fits.taggedIds).toEqual([1, 3]);
  });

  it('reorderOnly re-windows without touching placeholders', async () => {
    const r = await harness('source_rank', {
      maxItems: 2,
      present: [3, 1, 2],
      missing: [4],
      reorderOnly: true,
    });
    expect(r.ids).toEqual([1, 2]);
    expect(r.attempts).toEqual([]);
    expect(r.cleanup).not.toHaveBeenCalled();
    expect(r.taggedIds).toEqual([]);
  });

  it('skips placeholder rounds when placeholders are off', async () => {
    const r = await harness('source_rank', {
      maxItems: 4,
      createPlaceholdersForMissing: false,
    });
    expect(r.ids).toEqual([1, 3]);
    expect(r.attempts).toEqual([]);
    expect(r.cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('Coming Soon window order', () => {
  const sync = new ComingSoonCollectionSync();
  const config = (subtype: string) =>
    ({ subtype, libraryId: '1' } as unknown as CollectionConfig);

  it('ranks non-Trakt subtypes by release date with undated last', () => {
    const data = [
      source(1, ''),
      source(2, '2027-03-01'),
      { ...source(3, ''), mediaType: 'tv' as const, airDate: '2027-01-01' },
      source(4, '2027-02-01'),
    ];
    expect(
      sync.orderForWindow(data, config('monitored')).map((d) => d.tmdbId)
    ).toEqual([3, 4, 2, 1]);
    expect(
      sync
        .orderForWindow(data, config('trakt_anticipated'))
        .map((d) => d.tmdbId)
    ).toEqual([1, 2, 3, 4]);
  });
});

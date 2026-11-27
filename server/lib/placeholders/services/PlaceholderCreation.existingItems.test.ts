import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { MissingItem } from '@server/lib/collections/core/types';
import { assemblePlaceholderResult } from './PlaceholderCreation';

const missing = (tmdbId: number, originalPosition: number): MissingItem =>
  ({
    tmdbId,
    mediaType: 'movie',
    title: `t${tmdbId}`,
    originalPosition,
  } as MissingItem);

const record = (plexRatingKey: string | undefined, title = 'r') => ({
  mediaType: 'movie' as const,
  plexRatingKey,
  title,
});

const sourceMap = new Map(
  [1, 2, 3, 4, 5].map((id) => [id, { mediaType: 'movie' as const }])
);

const assemble = (
  overrides: Partial<Parameters<typeof assemblePlaceholderResult>[0]>
) =>
  assemblePlaceholderResult({
    discovered: new Map(),
    items: [],
    recordsByTmdbId: new Map(),
    sourceMap,
    libraryRatingKeys: new Set(),
    exclude: new Set(),
    ...overrides,
  });

describe('assemblePlaceholderResult', () => {
  it("keeps another collection's placeholder when this run also created one", () => {
    const result = assemble({
      discovered: new Map([[2, { ratingKey: '202', title: 'New' }]]),
      items: [missing(1, 1), missing(2, 2)],
      recordsByTmdbId: new Map([[1, [record('101', 'Shared')]]]),
      libraryRatingKeys: new Set(['101', '202']),
    });
    expect(result.map((i) => [i.tmdbId, i.ratingKey])).toEqual([
      [1, '101'],
      [2, '202'],
    ]);
  });

  it('keeps a placeholder owned by a multi-source collection', () => {
    // Multi-source records carry a `${parent}-${source}` config id; only the ratingKey matters
    const result = assemble({
      items: [missing(1, 1)],
      recordsByTmdbId: new Map([[1, [record('101')]]]),
      libraryRatingKeys: new Set(['101']),
    });
    expect(result.map((i) => i.ratingKey)).toEqual(['101']);
  });

  it('leaves out a ratingKey that is not in this library', () => {
    const result = assemble({
      items: [missing(1, 1)],
      recordsByTmdbId: new Map([[1, [record('999')]]]),
      libraryRatingKeys: new Set(['101']),
    });
    expect(result).toEqual([]);
  });

  it('picks the record that is in this library out of many', () => {
    const result = assemble({
      items: [missing(1, 1)],
      recordsByTmdbId: new Map([
        [1, [record('101'), record('801'), record(undefined)]],
      ]),
      libraryRatingKeys: new Set(['801']),
    });
    expect(result.map((i) => i.ratingKey)).toEqual(['801']);
  });

  it('returns each item once and honours the exclude set', () => {
    const result = assemble({
      discovered: new Map([[1, { ratingKey: '101', title: 'New' }]]),
      items: [missing(1, 1), missing(1, 1), missing(3, 3), missing(4, 4)],
      recordsByTmdbId: new Map([
        [1, [record('101')]],
        [3, [record('103')]],
        [4, [record('104')]],
      ]),
      libraryRatingKeys: new Set(['101', '103', '104']),
      exclude: new Set([4]),
    });
    expect(result.map((i) => i.tmdbId)).toEqual([1, 3]);
  });

  it('orders by source position, unknown positions last', () => {
    const result = assemble({
      discovered: new Map([
        [5, { ratingKey: '105', title: 'e' }],
        [3, { ratingKey: '103', title: 'c' }],
      ]),
      items: [missing(3, 3), missing(2, 1)],
      recordsByTmdbId: new Map([[2, [record('102')]]]),
      libraryRatingKeys: new Set(['102']),
    });
    expect(result.map((i) => i.tmdbId)).toEqual([2, 3, 5]);
  });
});

import type {
  MaintainerrCollection,
  MaintainerrMedia,
} from '@server/api/maintainerr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectSeasonCandidateKeys,
  computeDaysUntilAction,
  hasDeletionSchedule,
} from './maintainerrCountdown';

/**
 * `computeDaysUntilAction` is the single source of truth for the Maintainerr
 * deletion countdown: `buildRenderContext` uses it to set `context.daysUntilAction`
 * and the season subpass (Phase 3) uses it to decide which seasons are still
 * "active". These tests lock in the join, the math, the soonest-collection
 * tie-break, and the guards that keep bad data from producing a NaN countdown.
 */

const NOW = new Date('2026-01-31T00:00:00.000Z');

function makeMedia(partial: Partial<MaintainerrMedia>): MaintainerrMedia {
  return {
    id: 1,
    collectionId: 1,
    tmdbId: 100,
    addDate: '2026-01-01T00:00:00.000Z',
    image_path: '',
    isManual: false,
    ...partial,
  };
}

function makeCollection(
  partial: Partial<MaintainerrCollection>
): MaintainerrCollection {
  return {
    id: 1,
    libraryId: 1,
    title: 'Collection',
    description: '',
    isActive: true,
    arrAction: 0,
    visibleOnRecommended: false,
    visibleOnHome: false,
    deleteAfterDays: 30,
    manualCollection: false,
    manualCollectionName: '',
    listExclusions: false,
    forceOverseerr: false,
    type: 'season',
    keepLogsForMonths: 0,
    addDate: '2026-01-01T00:00:00.000Z',
    handledMediaAmount: 0,
    lastDurationInSeconds: 0,
    tautulliWatchedPercentOverride: null,
    radarrSettingsId: null,
    sonarrSettingsId: null,
    media: [],
    ...partial,
  };
}

describe('computeDaysUntilAction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('computes deleteAfterDays minus days-since-added (v3 mediaServerId join)', () => {
    // added 30 days ago, deleteAfterDays 45 => 15 days remaining
    const collection = makeCollection({
      title: 'Deleting Soon',
      deleteAfterDays: 45,
      media: [makeMedia({ mediaServerId: '25417' })],
    });

    const result = computeDaysUntilAction([collection], '25417');
    expect(result).not.toBeNull();
    expect(result?.days).toBe(15);
    expect(result?.collection.title).toBe('Deleting Soon');
  });

  it('joins v2 numeric plexId when mediaServerId is absent', () => {
    const collection = makeCollection({
      deleteAfterDays: 40,
      media: [makeMedia({ plexId: 25431 })],
    });

    const result = computeDaysUntilAction([collection], '25431');
    expect(result?.days).toBe(10);
  });

  it('returns null when the item is in no collection', () => {
    const collection = makeCollection({
      media: [makeMedia({ mediaServerId: '999' })],
    });
    expect(computeDaysUntilAction([collection], '25417')).toBeNull();
  });

  it('picks the collection acting SOONEST (lowest daysUntilAction)', () => {
    const later = makeCollection({
      title: 'Later',
      deleteAfterDays: 45, // 15 remaining
      media: [makeMedia({ mediaServerId: '25417' })],
    });
    const sooner = makeCollection({
      title: 'Sooner',
      deleteAfterDays: 35, // 5 remaining
      media: [makeMedia({ mediaServerId: '25417' })],
    });

    const result = computeDaysUntilAction([later, sooner], '25417');
    expect(result?.days).toBe(5);
    expect(result?.collection.title).toBe('Sooner');
  });

  it('breaks ties toward the first collection in array order', () => {
    const first = makeCollection({
      title: 'First',
      deleteAfterDays: 45,
      media: [makeMedia({ mediaServerId: '25417' })],
    });
    const second = makeCollection({
      title: 'Second',
      deleteAfterDays: 45,
      media: [makeMedia({ mediaServerId: '25417' })],
    });

    const result = computeDaysUntilAction([first, second], '25417');
    expect(result?.days).toBe(15);
    expect(result?.collection.title).toBe('First');
  });

  it('reports a negative (overdue) countdown rather than excluding it', () => {
    const collection = makeCollection({
      deleteAfterDays: 20, // added 30 days ago => -10
      media: [makeMedia({ mediaServerId: '25417' })],
    });
    expect(computeDaysUntilAction([collection], '25417')?.days).toBe(-10);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'excludes a collection with an unusable deleteAfterDays (%s)',
    (deleteAfterDays) => {
      const collection = makeCollection({
        deleteAfterDays: deleteAfterDays as number,
        media: [makeMedia({ mediaServerId: '25417' })],
      });
      expect(computeDaysUntilAction([collection], '25417')).toBeNull();
    }
  );

  it('excludes a media entry with an unparseable addDate (never NaN)', () => {
    const collection = makeCollection({
      deleteAfterDays: 30,
      media: [makeMedia({ mediaServerId: '25417', addDate: 'not-a-date' })],
    });
    expect(computeDaysUntilAction([collection], '25417')).toBeNull();
  });
});

/**
 * The season subpass pre-filters collections with `hasDeletionSchedule` before
 * fetching Plex metadata for their members. It must accept exactly the collections
 * `computeDaysUntilAction` would go on to accept, or the subpass would fetch
 * metadata for seasons that can never render a countdown.
 */
describe('hasDeletionSchedule', () => {
  it('accepts a finite positive deleteAfterDays', () => {
    expect(hasDeletionSchedule(makeCollection({ deleteAfterDays: 30 }))).toBe(
      true
    );
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an unusable deleteAfterDays (%s)',
    (deleteAfterDays) => {
      expect(
        hasDeletionSchedule(
          makeCollection({ deleteAfterDays: deleteAfterDays as number })
        )
      ).toBe(false);
    }
  );

  it('rejects a missing deleteAfterDays', () => {
    expect(
      hasDeletionSchedule(
        makeCollection({
          deleteAfterDays: undefined as unknown as number,
        })
      )
    ).toBe(false);
  });

  it('agrees with computeDaysUntilAction on every collection it rejects', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const unusable = [0, -1, Number.NaN, Number.POSITIVE_INFINITY].map((d) =>
      makeCollection({
        deleteAfterDays: d as number,
        media: [makeMedia({ mediaServerId: '25417' })],
      })
    );

    for (const collection of unusable) {
      expect(hasDeletionSchedule(collection)).toBe(false);
      expect(computeDaysUntilAction([collection], '25417')).toBeNull();
    }

    vi.useRealTimers();
  });
});

/**
 * The season subpass turns this selection into a Plex fetch, and the cleanup pass
 * reads an empty key set as "every tracked season departed" - the signal that
 * authorises restoring posters and deleting rows. So the distinction between
 * "no seasons" and "seasons we could not identify" is load-bearing.
 */
describe('collectSeasonCandidateKeys', () => {
  it('collects keys from season collections with a deletion schedule', () => {
    const selection = collectSeasonCandidateKeys([
      makeCollection({
        type: 'season',
        deleteAfterDays: 30,
        media: [
          makeMedia({ mediaServerId: '25417' }),
          makeMedia({ mediaServerId: '25431' }),
        ],
      }),
    ]);

    expect(selection.keys).toEqual(new Set(['25417', '25431']));
    expect(selection.seasonCollections).toBe(1);
    expect(selection.mediaWithoutKey).toBe(0);
    expect(selection.legacyTypedCollections).toBe(0);
  });

  it('falls back to the v2 plexId when mediaServerId is absent', () => {
    const selection = collectSeasonCandidateKeys([
      makeCollection({
        type: 'season',
        media: [makeMedia({ mediaServerId: undefined, plexId: 25417 })],
      }),
    ]);

    expect(selection.keys).toEqual(new Set(['25417']));
    expect(selection.mediaWithoutKey).toBe(0);
  });

  it('excludes non-season collections', () => {
    const selection = collectSeasonCandidateKeys([
      makeCollection({
        type: 'movie',
        media: [makeMedia({ mediaServerId: '111' })],
      }),
      makeCollection({
        type: 'show',
        media: [makeMedia({ mediaServerId: '222' })],
      }),
    ]);

    expect(selection.keys.size).toBe(0);
    expect(selection.seasonCollections).toBe(0);
    expect(selection.mediaWithoutKey).toBe(0);
  });

  it('excludes a season collection without a usable deletion schedule', () => {
    const selection = collectSeasonCandidateKeys([
      makeCollection({
        type: 'season',
        deleteAfterDays: 0,
        media: [makeMedia({ mediaServerId: '25417' })],
      }),
    ]);

    expect(selection.keys.size).toBe(0);
    expect(selection.seasonCollections).toBe(0);
    // Its media are never inspected, so they cannot read as ambiguous.
    expect(selection.mediaWithoutKey).toBe(0);
  });

  it('counts a legacy numeric-typed collection and takes no keys from it', () => {
    const selection = collectSeasonCandidateKeys([
      makeCollection({
        type: 3 as unknown as string,
        media: [makeMedia({ mediaServerId: '25417' })],
      }),
    ]);

    expect(selection.keys.size).toBe(0);
    expect(selection.legacyTypedCollections).toBe(1);
    expect(selection.seasonCollections).toBe(0);
  });

  it('counts an unidentifiable media entry rather than silently dropping it', () => {
    const selection = collectSeasonCandidateKeys([
      makeCollection({
        type: 'season',
        media: [
          makeMedia({ mediaServerId: '25417' }),
          makeMedia({ mediaServerId: undefined, plexId: undefined }),
        ],
      }),
    ]);

    expect(selection.keys).toEqual(new Set(['25417']));
    expect(selection.mediaWithoutKey).toBe(1);
  });

  it('distinguishes an all-unidentifiable payload from a genuinely empty one', () => {
    const malformed = collectSeasonCandidateKeys([
      makeCollection({
        type: 'season',
        media: [makeMedia({ mediaServerId: undefined, plexId: undefined })],
      }),
    ]);
    const empty = collectSeasonCandidateKeys([
      makeCollection({ type: 'season', media: [] }),
    ]);

    // Both yield zero keys; only the malformed one signals ambiguity.
    expect(malformed.keys.size).toBe(0);
    expect(malformed.mediaWithoutKey).toBe(1);

    expect(empty.keys.size).toBe(0);
    expect(empty.mediaWithoutKey).toBe(0);
  });

  it('dedupes a season present in two collections', () => {
    const selection = collectSeasonCandidateKeys([
      makeCollection({
        id: 1,
        type: 'season',
        media: [makeMedia({ mediaServerId: '25417' })],
      }),
      makeCollection({
        id: 2,
        type: 'season',
        media: [makeMedia({ mediaServerId: '25417' })],
      }),
    ]);

    expect(selection.keys).toEqual(new Set(['25417']));
    expect(selection.seasonCollections).toBe(2);
  });
});

import type {
  MaintainerrCollection,
  MaintainerrMedia,
} from '@server/api/maintainerr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeDaysUntilAction } from './maintainerrCountdown';

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

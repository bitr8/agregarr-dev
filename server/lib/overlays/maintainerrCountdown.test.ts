import type {
  MaintainerrCollection,
  MaintainerrMedia,
} from '@server/api/maintainerr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectSeasonCandidateKeys,
  computeDaysUntilAction,
  hasDeletionSchedule,
  seasonFallbackFor,
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
 * The show-level fallback: a show whose own ratingKey is in no collection
 * inheriting a countdown from its seasons, which Maintainerr only exposes via the
 * parent series' tmdbId on each season row.
 *
 * What makes this worth locking down is that the modes disagree on purpose. `'any'`
 * says "a season is going" and dates the poster by the first departure; `'all'`
 * says "the show is going" and will not commit unless it can prove every season is
 * scheduled, dating the poster by the season that goes last or the one that goes
 * first, whichever the library asked for. Every unprovable case in `'all'` -
 * a season staying, a row it cannot attribute to a season, a count that does not
 * line up with Plex - has to come back null, because a wrong date here tells a user
 * a show is leaving when it is not.
 */
describe('computeDaysUntilAction show-level season fallback', () => {
  const SHOW_KEY = 'show-1';
  const SEASON_1 = { mediaServerId: 'season-1' };
  // Added 10 days later than the default, so at a given deleteAfterDays it has 10
  // more days left - it is the season that goes LAST.
  const SEASON_2 = {
    mediaServerId: 'season-2',
    addDate: '2026-01-11T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function forShow(
    mode: 'off' | 'any' | 'all',
    totalSeasons?: number,
    // The engine's own default. Spelled out here so an earliest-mode case reads
    // as a deliberate choice rather than an omission.
    useLatestSeasonDate = true
  ) {
    return {
      mediaType: 'show',
      tmdbId: 100,
      seasonFallback: { mode, useLatestSeasonDate },
      totalSeasons,
    };
  }

  it("takes nothing from the seasons in 'off' mode", () => {
    const collection = makeCollection({
      media: [makeMedia(SEASON_1), makeMedia(SEASON_2)],
    });

    expect(
      computeDaysUntilAction([collection], SHOW_KEY, forShow('off'))
    ).toBeNull();
  });

  it('defaults to off when the caller names no mode', () => {
    const collection = makeCollection({ media: [makeMedia(SEASON_1)] });

    expect(
      computeDaysUntilAction([collection], SHOW_KEY, {
        mediaType: 'show',
        tmdbId: 100,
      })
    ).toBeNull();
  });

  it("'any' takes the soonest season's date", () => {
    const sooner = makeCollection({
      id: 1,
      title: 'Sooner',
      deleteAfterDays: 35, // season 1 => 5
      media: [makeMedia(SEASON_1)],
    });
    const later = makeCollection({
      id: 2,
      title: 'Later',
      deleteAfterDays: 45, // season 1 => 15, season 2 => 25
      media: [makeMedia(SEASON_1), makeMedia(SEASON_2)],
    });

    const result = computeDaysUntilAction(
      [later, sooner],
      SHOW_KEY,
      forShow('any')
    );
    expect(result?.days).toBe(5);
    expect(result?.collection.title).toBe('Sooner');
    // Two seasons are leaving, across three matched rows.
    expect(result?.childItemsMatched).toBe(2);
  });

  it("'any' lets an episode row drive the date without counting it as a season", () => {
    const episodes = makeCollection({
      id: 1,
      title: 'Episodes',
      type: 'episode',
      deleteAfterDays: 35, // episode => 5, the soonest date on offer
      media: [makeMedia({ mediaServerId: 'episode-1' })],
    });
    const seasons = makeCollection({
      id: 2,
      title: 'Seasons',
      deleteAfterDays: 45, // season 1 => 15
      media: [makeMedia(SEASON_1)],
    });

    const result = computeDaysUntilAction(
      [seasons, episodes],
      SHOW_KEY,
      forShow('any')
    );
    expect(result?.days).toBe(5);
    expect(result?.collection.title).toBe('Episodes');
    // One SEASON is leaving. The episode drives the date, but counting it as a
    // season would make `seasonsLeavingCount` lie about what it is named for.
    expect(result?.childItemsMatched).toBe(1);
  });

  it("'all' dates the show by the season that leaves LAST", () => {
    const collection = makeCollection({
      deleteAfterDays: 45, // season 1 => 15, season 2 => 25
      media: [makeMedia(SEASON_1), makeMedia(SEASON_2)],
    });

    const result = computeDaysUntilAction(
      [collection],
      SHOW_KEY,
      forShow('all', 2)
    );
    expect(result?.days).toBe(25);
    expect(result?.childItemsMatched).toBe(2);
  });

  it("'all' takes each season's soonest collection, then the latest of those", () => {
    const slow = makeCollection({
      id: 1,
      title: 'Slow',
      deleteAfterDays: 45, // season 1 => 15, season 2 => 25
      media: [makeMedia(SEASON_1), makeMedia(SEASON_2)],
    });
    const fast = makeCollection({
      id: 2,
      title: 'Fast',
      deleteAfterDays: 30, // season 2 => 10
      media: [makeMedia(SEASON_2)],
    });

    // Season 2 leaves in 10 (Fast beats Slow's 25), season 1 in 15, so the show
    // goes in 15. Summing rows or skipping the per-season minimum gives 25.
    const result = computeDaysUntilAction(
      [slow, fast],
      SHOW_KEY,
      forShow('all', 2)
    );
    expect(result?.days).toBe(15);
    expect(result?.collection.title).toBe('Slow');
    expect(result?.childItemsMatched).toBe(2);
  });

  it("'all' dates the show by the latest season when no date preference is given", () => {
    const collection = makeCollection({
      deleteAfterDays: 45, // season 1 => 15, season 2 => 25
      media: [makeMedia(SEASON_1), makeMedia(SEASON_2)],
    });

    // Deliberately derived from a config where the flag is genuinely ABSENT: a
    // library row written before the `useLatestSeasonDate` column existed reads
    // as undefined, and that must mean "latest" - the behavior every
    // all-seasons library had before the dropdown - not "earliest".
    const result = computeDaysUntilAction([collection], SHOW_KEY, {
      mediaType: 'show',
      tmdbId: 100,
      seasonFallback: seasonFallbackFor({ requireAllSeasonsLeaving: true }),
      totalSeasons: 2,
    });
    expect(result?.days).toBe(25);
    expect(result?.childItemsMatched).toBe(2);
  });

  it("'all' earliest dates the show by the season that leaves FIRST", () => {
    const collection = makeCollection({
      deleteAfterDays: 45, // season 1 => 15, season 2 => 25
      media: [makeMedia(SEASON_1), makeMedia(SEASON_2)],
    });

    // The mirror of the latest case on identical data: this answers "when does
    // the deletion start", so 15 rather than 25.
    const result = computeDaysUntilAction(
      [collection],
      SHOW_KEY,
      forShow('all', 2, false)
    );
    expect(result?.days).toBe(15);
    expect(result?.childItemsMatched).toBe(2);
  });

  it("'all' earliest takes each season's soonest collection, then the soonest of those", () => {
    const slow = makeCollection({
      id: 1,
      title: 'Slow',
      deleteAfterDays: 45, // season 1 => 15, season 2 => 25
      media: [makeMedia(SEASON_1), makeMedia(SEASON_2)],
    });
    const fast = makeCollection({
      id: 2,
      title: 'Fast',
      deleteAfterDays: 30, // season 2 => 10
      media: [makeMedia(SEASON_2)],
    });

    // Season 2 leaves in 10 (Fast beats Slow's 25), season 1 in 15, so the first
    // departure is season 2's. Only the per-season minimum survives into the
    // cross-season reduce, so the winner has to be Fast, not Slow's 15.
    const result = computeDaysUntilAction(
      [slow, fast],
      SHOW_KEY,
      forShow('all', 2, false)
    );
    expect(result?.days).toBe(10);
    // Asserted because a reduce that tracks days alone would report Fast's date
    // under whichever collection it happened to be holding.
    expect(result?.collection.title).toBe('Fast');
    expect(result?.childItemsMatched).toBe(2);
  });

  it("'all' earliest still stays silent while one season is unscheduled", () => {
    const collection = makeCollection({
      media: [makeMedia(SEASON_1), makeMedia(SEASON_2)],
    });

    // Picking the earliest date is a presentation choice; it does not lower the
    // bar for proving the show is leaving at all.
    expect(
      computeDaysUntilAction([collection], SHOW_KEY, forShow('all', 3, false))
    ).toBeNull();
  });

  it("'all' earliest still stays silent when a matched row carries no key", () => {
    const collection = makeCollection({
      media: [
        makeMedia(SEASON_1),
        makeMedia({ mediaServerId: undefined, plexId: undefined }),
      ],
    });

    // Earliest mode is the one where an unattributable row is most tempting to
    // shrug off - it can only ever be beaten by an earlier date, never change
    // the answer upward. It is still a season we cannot prove is going.
    expect(
      computeDaysUntilAction([collection], SHOW_KEY, forShow('all', 2, false))
    ).toBeNull();
  });

  it("'all' stays silent while one season is unscheduled", () => {
    // Plex says three seasons; Maintainerr is tracking two, so the third - a
    // numbered season or the Specials folder - keeps the show in the library.
    const collection = makeCollection({
      media: [makeMedia(SEASON_1), makeMedia(SEASON_2)],
    });

    expect(
      computeDaysUntilAction([collection], SHOW_KEY, forShow('all', 3))
    ).toBeNull();
  });

  it("'all' counts Specials as one of the seasons that must be leaving", () => {
    // childCount includes season 0, so the denominator only balances once the
    // Specials folder is scheduled too.
    const collection = makeCollection({
      deleteAfterDays: 45, // specials and season 1 => 15, season 2 => 25
      media: [
        makeMedia({ mediaServerId: 'season-0' }),
        makeMedia(SEASON_1),
        makeMedia(SEASON_2),
      ],
    });

    const result = computeDaysUntilAction(
      [collection],
      SHOW_KEY,
      forShow('all', 3)
    );
    expect(result?.days).toBe(25);
    expect(result?.childItemsMatched).toBe(3);
  });

  it("'all' stays silent when a matched row carries no key", () => {
    const collection = makeCollection({
      media: [
        makeMedia(SEASON_1),
        makeMedia({ mediaServerId: undefined, plexId: undefined }),
      ],
    });

    // The unidentifiable row may or may not be the second season - unprovable.
    expect(
      computeDaysUntilAction([collection], SHOW_KEY, forShow('all', 2))
    ).toBeNull();
  });

  it("'all' stays silent when the seasons outnumber Plex's childCount", () => {
    const collection = makeCollection({
      media: [
        makeMedia(SEASON_1),
        makeMedia(SEASON_2),
        // A stale row, or this show in a second library. Either way the join is
        // no longer describing the two seasons in front of us.
        makeMedia({ mediaServerId: 'season-stale' }),
      ],
    });

    expect(
      computeDaysUntilAction([collection], SHOW_KEY, forShow('all', 2))
    ).toBeNull();
  });

  it("'all' does not let another library's season key complete the proof", () => {
    const local = makeCollection({
      id: 1,
      libraryId: 1,
      media: [makeMedia(SEASON_1)],
    });
    // Same show in a second library: same tmdbId, different season ratingKey.
    // One local season scheduled out of two — a foreign key must not close the gap.
    const foreign = makeCollection({
      id: 2,
      libraryId: 2,
      media: [makeMedia({ mediaServerId: 'season-1-other-library' })],
    });

    expect(
      computeDaysUntilAction([local, foreign], SHOW_KEY, {
        mediaType: 'show',
        tmdbId: 100,
        seasonFallback: {
          mode: 'all',
          useLatestSeasonDate: true,
          librarySectionId: 1,
        },
        totalSeasons: 2,
      })
    ).toBeNull();
  });

  it("'all' still fires when the local library alone accounts for every season", () => {
    const local = makeCollection({
      id: 1,
      libraryId: 1,
      deleteAfterDays: 45, // season 1 => 15, season 2 => 25
      media: [makeMedia(SEASON_1), makeMedia(SEASON_2)],
    });
    // Without the scope this foreign row overshoots the count (3 keys vs 2)
    // and would silence a show whose local proof is complete.
    const foreign = makeCollection({
      id: 2,
      libraryId: 2,
      media: [makeMedia({ mediaServerId: 'season-1-other-library' })],
    });

    const result = computeDaysUntilAction([local, foreign], SHOW_KEY, {
      mediaType: 'show',
      tmdbId: 100,
      seasonFallback: {
        mode: 'all',
        useLatestSeasonDate: true,
        // String section id against numeric collection ids: both sides coerce.
        librarySectionId: '1',
      },
      totalSeasons: 2,
    });

    expect(result?.days).toBe(25);
  });

  it("'all' ignores a foreign keyless row instead of aborting the local proof", () => {
    const local = makeCollection({
      id: 1,
      libraryId: 1,
      deleteAfterDays: 45,
      media: [makeMedia(SEASON_1), makeMedia(SEASON_2)],
    });
    // A keyless row aborts the proof — but only from a collection in scope.
    const foreign = makeCollection({
      id: 2,
      libraryId: 2,
      media: [makeMedia({ mediaServerId: undefined, plexId: undefined })],
    });

    const result = computeDaysUntilAction([local, foreign], SHOW_KEY, {
      mediaType: 'show',
      tmdbId: 100,
      seasonFallback: {
        mode: 'all',
        useLatestSeasonDate: true,
        librarySectionId: 1,
      },
      totalSeasons: 2,
    });

    expect(result?.days).toBe(25);
  });

  it("'all' counts every library when the fallback names no section", () => {
    const local = makeCollection({
      id: 1,
      libraryId: 1,
      media: [makeMedia(SEASON_1)],
    });
    const foreign = makeCollection({
      id: 2,
      libraryId: 2,
      media: [makeMedia({ mediaServerId: 'season-1-other-library' })],
    });

    expect(
      computeDaysUntilAction([local, foreign], SHOW_KEY, forShow('all', 2))
    ).not.toBeNull();
  });

  it("'all' stays silent when Plex reported no childCount", () => {
    const collection = makeCollection({
      media: [makeMedia(SEASON_1), makeMedia(SEASON_2)],
    });

    expect(
      computeDaysUntilAction([collection], SHOW_KEY, forShow('all'))
    ).toBeNull();
  });

  it("'all' ignores episode-type collections", () => {
    const seasons = makeCollection({
      id: 1,
      title: 'Seasons',
      type: 'season',
      deleteAfterDays: 45, // season 1 => 15
      media: [makeMedia(SEASON_1)],
    });
    const episodes = makeCollection({
      id: 2,
      title: 'Episodes',
      type: 'episode',
      deleteAfterDays: 35, // would be 5, and would add two more "seasons"
      media: [
        makeMedia({ mediaServerId: 'episode-1' }),
        makeMedia({ mediaServerId: 'episode-2' }),
      ],
    });

    const result = computeDaysUntilAction(
      [seasons, episodes],
      SHOW_KEY,
      forShow('all', 1)
    );
    expect(result?.days).toBe(15);
    expect(result?.collection.title).toBe('Seasons');
    expect(result?.childItemsMatched).toBe(1);
  });

  it.each(['off', 'any', 'all'] as const)(
    'a direct show ratingKey match wins in %s mode',
    (mode) => {
      const showLevel = makeCollection({
        id: 1,
        title: 'Show Level',
        type: 'show',
        deleteAfterDays: 40, // => 10
        media: [makeMedia({ mediaServerId: SHOW_KEY })],
      });
      const seasonLevel = makeCollection({
        id: 2,
        title: 'Season Level',
        type: 'season',
        deleteAfterDays: 35, // => 5, and would be the whole show under 'all'
        media: [makeMedia(SEASON_1), makeMedia(SEASON_2)],
      });

      const result = computeDaysUntilAction(
        [seasonLevel, showLevel],
        SHOW_KEY,
        forShow(mode, 2)
      );
      expect(result?.days).toBe(10);
      expect(result?.collection.title).toBe('Show Level');
      expect(result?.childItemsMatched).toBe(0);
    }
  );

  it.each(['any', 'all'] as const)(
    'a direct match with an unreadable date blocks the fallback in %s mode',
    (mode) => {
      const showLevel = makeCollection({
        id: 1,
        title: 'Show Level',
        type: 'show',
        media: [makeMedia({ mediaServerId: SHOW_KEY, addDate: 'not-a-date' })],
      });
      const seasonLevel = makeCollection({
        id: 2,
        title: 'Season Level',
        deleteAfterDays: 35,
        media: [makeMedia(SEASON_1), makeMedia(SEASON_2)],
      });

      // The show has a schedule of its own; we just cannot read its date. A
      // season's date would be describing a different event entirely.
      expect(
        computeDaysUntilAction(
          [seasonLevel, showLevel],
          SHOW_KEY,
          forShow(mode, 2)
        )
      ).toBeNull();
    }
  );

  it('a readable direct match still wins alongside an unreadable one', () => {
    const unreadable = makeCollection({
      id: 1,
      title: 'Unreadable',
      type: 'show',
      deleteAfterDays: 20,
      media: [makeMedia({ mediaServerId: SHOW_KEY, addDate: 'not-a-date' })],
    });
    const readable = makeCollection({
      id: 2,
      title: 'Readable',
      type: 'show',
      deleteAfterDays: 40, // => 10
      media: [makeMedia({ mediaServerId: SHOW_KEY })],
    });
    const seasonLevel = makeCollection({
      id: 3,
      deleteAfterDays: 35, // => 5, and would win under 'any'
      media: [makeMedia(SEASON_1), makeMedia(SEASON_2)],
    });

    const result = computeDaysUntilAction(
      [unreadable, readable, seasonLevel],
      SHOW_KEY,
      forShow('any')
    );
    expect(result?.days).toBe(10);
    expect(result?.collection.title).toBe('Readable');
    expect(result?.childItemsMatched).toBe(0);
  });

  it('never falls back for a movie, whatever the mode says', () => {
    const collection = makeCollection({ media: [makeMedia(SEASON_1)] });

    expect(
      computeDaysUntilAction([collection], SHOW_KEY, {
        mediaType: 'movie',
        tmdbId: 100,
        seasonFallback: { mode: 'any', useLatestSeasonDate: true },
      })
    ).toBeNull();
  });
});

/**
 * One input, and pointedly not two: the "Season deletion countdown" toggle is not
 * consulted here. It gates the season-poster subpass and the departed-season
 * cleanup, and a user is entitled to want the show poster marked without every
 * season poster being overlaid as well. Wiring that toggle back in would silently
 * take the show countdown away from those libraries.
 *
 * Which leaves the show-level fallback answering to its own control, whose default
 * - an unset config - is "Any season", develop's behavior.
 */
describe('seasonFallbackFor', () => {
  it('is all when the library asks for every season', () => {
    expect(seasonFallbackFor({ requireAllSeasonsLeaving: true }).mode).toBe(
      'all'
    );
  });

  it('is any when the library does not', () => {
    expect(seasonFallbackFor({ requireAllSeasonsLeaving: false }).mode).toBe(
      'any'
    );
  });

  it('is any for a config predating the columns', () => {
    expect(seasonFallbackFor({}).mode).toBe('any');
  });

  it('reads an absent date preference as latest', () => {
    // The column defaults to true. A row loaded before the migration ran has no
    // value at all, and must not read as "earliest" - that would move the date
    // on every existing all-seasons library without anyone touching a setting.
    expect(seasonFallbackFor({}).useLatestSeasonDate).toBe(true);
    expect(
      seasonFallbackFor({ requireAllSeasonsLeaving: true }).useLatestSeasonDate
    ).toBe(true);
  });

  it('honours an explicit earliest', () => {
    expect(
      seasonFallbackFor({
        requireAllSeasonsLeaving: true,
        useLatestSeasonDate: false,
      })
    ).toEqual({ mode: 'all', useLatestSeasonDate: false });
  });

  it("carries the config's library id as the section scope", () => {
    expect(seasonFallbackFor({ libraryId: 3 }).librarySectionId).toBe(3);
    expect(seasonFallbackFor({}).librarySectionId).toBeUndefined();
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

import type {
  MaintainerrCollection,
  MaintainerrMedia,
} from '@server/api/maintainerr';

/**
 * Result of a Maintainerr deletion-countdown lookup for a single Plex ratingKey:
 * how many days until Maintainerr acts on the item, and the collection that
 * yielded the selected action.
 */
export interface MaintainerrCountdown {
  /** deleteAfterDays minus days-since-added. Positive = remaining, negative = overdue. */
  days: number;
  /** The collection whose schedule produced `days`. */
  collection: MaintainerrCollection;
  /** Distinct child items matched via the tmdbId fallback (0 for direct ratingKey hits). */
  childItemsMatched: number;
}

/**
 * How a show poster may inherit a countdown from its seasons, when the show's own
 * ratingKey is in no collection.
 *
 * - `'off'` - never. The library's "Season deletion countdown" toggle is off, so a
 *   season leaving is a season's business and the show poster stays clean.
 * - `'any'` - one leaving season is enough, and the show shows the SOONEST season's
 *   date. Every collection type contributes, matching the pre-sub-toggle behaviour.
 * - `'all'` - the show only gets a countdown once every one of its seasons is
 *   scheduled, and it shows the LAST one to go, i.e. the day the show itself
 *   disappears from Plex. Season-typed collections only.
 */
export type SeasonFallbackMode = 'off' | 'any' | 'all';

/**
 * Read a library's two season-countdown toggles as a single mode.
 *
 * Every caller that builds a show's render context goes through here, so the
 * parent toggle gates the show-level fallback in exactly one place and the
 * sub-toggle cannot be honoured on one code path and ignored on another.
 */
export function seasonFallbackModeFor(config: {
  enableMaintainerrSeasonOverlays?: boolean;
  requireAllSeasonsLeaving?: boolean;
}): SeasonFallbackMode {
  if (!config.enableMaintainerrSeasonOverlays) {
    return 'off';
  }
  return config.requireAllSeasonsLeaving ? 'all' : 'any';
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * True when a collection has a usable deletion schedule, i.e. a `deleteAfterDays`
 * that can produce a real countdown rather than a NaN or a never-expiring one.
 *
 * `computeDaysUntilAction` applies this to every collection it considers, so
 * callers that pre-filter collections before doing expensive work (the season
 * subpass fetches Plex metadata for candidate keys) share the exact same test and
 * cannot select an item the countdown would then reject.
 */
export function hasDeletionSchedule(
  collection: MaintainerrCollection
): boolean {
  const { deleteAfterDays } = collection;
  return (
    typeof deleteAfterDays === 'number' &&
    Number.isFinite(deleteAfterDays) &&
    deleteAfterDays > 0
  );
}

/** What `collectSeasonCandidateKeys` found in a Maintainerr payload. */
export interface SeasonCandidateSelection {
  /** Plex season ratingKeys to resolve. */
  keys: Set<string>;
  /** Season collections with a usable deletion schedule. */
  seasonCollections: number;
  /** Collections whose `type` was not a string (Maintainerr <3.4.0), all excluded. */
  legacyTypedCollections: number;
  /**
   * Media entries in a season collection that carried neither `mediaServerId` nor
   * `plexId`. Each is a season we know Maintainerr is tracking but cannot identify,
   * so the selection is ambiguous rather than empty.
   */
  mediaWithoutKey: number;
}

/**
 * Select the Plex season ratingKeys a Maintainerr payload nominates for a deletion
 * countdown.
 *
 * Only collections that are typed `'season'` AND carry a usable deletion schedule
 * contribute - the same test `computeDaysUntilAction` applies, so nothing is
 * fetched that the countdown would then reject.
 *
 * `mediaWithoutKey` matters more than it looks: an empty key set means "every
 * tracked season has departed", which is exactly the signal that authorises
 * restoring posters and dropping rows. A payload whose media entries all lack ids
 * would otherwise be indistinguishable from that. Counting them lets the caller
 * treat an unjoinable entry as ambiguity instead of a departure.
 */
export function collectSeasonCandidateKeys(
  collections: MaintainerrCollection[]
): SeasonCandidateSelection {
  const keys = new Set<string>();
  let seasonCollections = 0;
  let legacyTypedCollections = 0;
  let mediaWithoutKey = 0;

  for (const collection of collections) {
    // Maintainerr <3.4.0 sent a numeric type whose season value was never
    // verified. Excluded rather than guessed at.
    if (typeof collection.type !== 'string') {
      legacyTypedCollections++;
      continue;
    }

    if (collection.type !== 'season' || !hasDeletionSchedule(collection)) {
      continue;
    }

    seasonCollections++;
    for (const media of collection.media) {
      const key = mediaKey(media);
      if (key) {
        keys.add(key);
      } else {
        mediaWithoutKey++;
      }
    }
  }

  return { keys, seasonCollections, legacyTypedCollections, mediaWithoutKey };
}

/**
 * `deleteAfterDays - daysSinceAdded` for one media row, or null when its `addDate`
 * will not parse. Callers drop a null rather than letting it become a NaN
 * countdown that renders as "leaving in NaN days".
 */
function rowDays(
  collection: MaintainerrCollection,
  media: MaintainerrMedia
): number | null {
  const addedTime = new Date(media.addDate).getTime();
  if (Number.isNaN(addedTime)) {
    return null;
  }

  const daysSinceAdded = Math.floor((Date.now() - addedTime) / MS_PER_DAY);
  return collection.deleteAfterDays - daysSinceAdded;
}

/** The Plex ratingKey a media row points at (v3 `mediaServerId`, v2 `plexId`). */
function mediaKey(media: MaintainerrMedia): string | undefined {
  return media.mediaServerId || media.plexId?.toString();
}

/**
 * Compute the Maintainerr deletion countdown for a Plex item.
 *
 * Joins the item's ratingKey against every collection's media list (v3
 * `mediaServerId` or v2 `plexId`) and, for each collection with a valid deletion
 * schedule, computes `deleteAfterDays - daysSinceAdded`. When the item belongs to
 * multiple collections, the one acting SOONEST (lowest daysUntilAction) wins.
 *
 * A collection only contributes when its `deleteAfterDays` is a finite positive
 * number and the media entry has a parseable `addDate`, so an unusable value can
 * never surface as a NaN countdown. Returns null when the item is in no
 * collection with a countdown.
 *
 * A show whose own ratingKey is in no collection may still inherit a countdown
 * from its seasons: Maintainerr stamps season rows with the parent series'
 * tmdbId, which is the only join available. `opts.seasonFallback` decides whether
 * and how (see `SeasonFallbackMode`); it defaults to `'off'`, so a caller that
 * has not consulted the library toggle cannot leak a season's date onto a show.
 * A direct ratingKey hit always wins outright: the show has its own schedule and
 * what its seasons are doing is beside the point. That holds even when the hit
 * yields no usable date. A show Maintainerr is scheduling by an unreadable
 * `addDate` gets no countdown at all, rather than quietly falling through to a
 * season's date that describes something else.
 *
 * This is the single source of truth for the countdown: `buildRenderContext`
 * calls it to set `context.daysUntilAction`, and the season subpass calls it to
 * decide which seasons are still "active" — the render predicate and the
 * active-set predicate cannot drift.
 */
export function computeDaysUntilAction(
  collections: MaintainerrCollection[],
  ratingKey: string,
  opts?: {
    mediaType?: string;
    tmdbId?: number;
    seasonFallback?: SeasonFallbackMode;
    /** The show's Plex `childCount`. Required by `'all'`, ignored otherwise. */
    totalSeasons?: number;
  }
): MaintainerrCountdown | null {
  const direct: { collection: MaintainerrCollection; days: number }[] = [];
  // Tracked separately from `direct`, which only holds rows that produced a
  // date: the fallback is barred by the EXISTENCE of a schedule for this item,
  // not by our success in reading it.
  let directMatched = false;

  for (const collection of collections) {
    if (!hasDeletionSchedule(collection)) {
      continue;
    }

    for (const media of collection.media) {
      if (mediaKey(media) !== ratingKey) {
        continue;
      }

      directMatched = true;
      const days = rowDays(collection, media);
      if (days !== null) {
        direct.push({ collection, days });
      }
    }
  }

  if (directMatched) {
    if (direct.length === 0) {
      return null;
    }

    // Item may be in multiple collections; the one acting soonest wins.
    const best = direct.reduce((min, curr) =>
      curr.days < min.days ? curr : min
    );
    return { ...best, childItemsMatched: 0 };
  }

  const mode = opts?.seasonFallback ?? 'off';
  if (mode === 'off' || opts?.mediaType !== 'show' || !opts?.tmdbId) {
    return null;
  }

  return mode === 'all'
    ? allSeasonsCountdown(collections, opts.tmdbId, opts.totalSeasons)
    : anySeasonCountdown(collections, opts.tmdbId);
}

/**
 * `'any'` fallback: the soonest date among every row Maintainerr tags with this
 * show's tmdbId, across all collection types (episode-typed collections included,
 * as they were before the sub-toggle existed).
 *
 * `childItemsMatched` counts DISTINCT keys rather than rows, so a season sitting
 * in two collections is one departing season, not two. Rows Maintainerr sent
 * without a key still drive the date but cannot be counted, since they are
 * indistinguishable from each other.
 */
function anySeasonCountdown(
  collections: MaintainerrCollection[],
  tmdbId: number
): MaintainerrCountdown | null {
  const matches: { collection: MaintainerrCollection; days: number }[] = [];
  const childKeys = new Set<string>();

  for (const collection of collections) {
    if (!hasDeletionSchedule(collection)) {
      continue;
    }

    for (const media of collection.media) {
      if (Number(media.tmdbId) !== tmdbId) {
        continue;
      }

      const days = rowDays(collection, media);
      if (days === null) {
        continue;
      }

      matches.push({ collection, days });
      const key = mediaKey(media);
      if (key) {
        childKeys.add(key);
      }
    }
  }

  if (matches.length === 0) {
    return null;
  }

  const best = matches.reduce((min, curr) =>
    curr.days < min.days ? curr : min
  );
  return { ...best, childItemsMatched: childKeys.size };
}

/**
 * `'all'` fallback: a countdown only when EVERY season of the show is scheduled,
 * dated by the last one to leave. That is the day the show's listing disappears
 * from Plex rather than the day it gets shorter.
 *
 * Only season-typed collections count (same filter as `collectSeasonCandidateKeys`);
 * an episode-typed collection says nothing about whether a season is going.
 * Within a season the soonest collection wins, exactly as for a directly matched
 * item; across seasons the latest of those wins.
 *
 * Anything that stops us PROVING every season is leaving returns null rather than
 * a guess: no `totalSeasons` (Plex gave no `childCount`), a matched row with no
 * ratingKey to identify its season, or a distinct-season count that misses
 * `totalSeasons` in either direction. Short means a season is staying; long means
 * rows we cannot attribute (a stale season, another library's copy of the show)
 * inflated the join.
 */
function allSeasonsCountdown(
  collections: MaintainerrCollection[],
  tmdbId: number,
  totalSeasons: number | undefined
): MaintainerrCountdown | null {
  if (!totalSeasons || totalSeasons <= 0) {
    return null;
  }

  const bySeason = new Map<
    string,
    { collection: MaintainerrCollection; days: number }
  >();

  for (const collection of collections) {
    if (collection.type !== 'season' || !hasDeletionSchedule(collection)) {
      continue;
    }

    for (const media of collection.media) {
      if (Number(media.tmdbId) !== tmdbId) {
        continue;
      }

      const key = mediaKey(media);
      if (!key) {
        return null;
      }

      const days = rowDays(collection, media);
      if (days === null) {
        continue;
      }

      const soonest = bySeason.get(key);
      if (!soonest || days < soonest.days) {
        bySeason.set(key, { collection, days });
      }
    }
  }

  if (bySeason.size !== totalSeasons) {
    return null;
  }

  const last = [...bySeason.values()].reduce((max, curr) =>
    curr.days > max.days ? curr : max
  );
  return { ...last, childItemsMatched: bySeason.size };
}

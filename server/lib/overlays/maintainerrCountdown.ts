import type { MaintainerrCollection } from '@server/api/maintainerr';

/**
 * Result of a Maintainerr deletion-countdown lookup for a single Plex ratingKey:
 * how many days until Maintainerr acts on the item, and the collection that
 * yielded the soonest action.
 */
export interface MaintainerrCountdown {
  /** deleteAfterDays minus days-since-added. Positive = remaining, negative = overdue. */
  days: number;
  /** The collection with the LOWEST daysUntilAction for this item. */
  collection: MaintainerrCollection;
  /** Season/episode members matched via the tmdbId fallback (0 for direct ratingKey hits). */
  childItemsMatched: number;
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
      const key = media.mediaServerId || media.plexId?.toString();
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
 * This is the single source of truth for the countdown: `buildRenderContext`
 * calls it to set `context.daysUntilAction`, and the season subpass calls it to
 * decide which seasons are still "active" — the render predicate and the
 * active-set predicate cannot drift.
 */
export function computeDaysUntilAction(
  collections: MaintainerrCollection[],
  ratingKey: string,
  opts?: { mediaType?: string; tmdbId?: number }
): MaintainerrCountdown | null {
  const matches: { collection: MaintainerrCollection; days: number }[] = [];
  let childItemsMatched = 0;

  for (const collection of collections) {
    if (!hasDeletionSchedule(collection)) {
      continue;
    }

    let mediaItems = collection.media.filter((m) => {
      const id = m.mediaServerId || m.plexId?.toString();
      return id === ratingKey;
    });

    // Fallback for season/episode-scoped Maintainerr collections: their members
    // carry season ratingKeys that never equal the show's ratingKey. Maintainerr
    // reports the parent series' tmdbId on those rows, so match by that instead.
    if (mediaItems.length === 0 && opts?.mediaType === 'show' && opts?.tmdbId) {
      const tid = opts.tmdbId;
      mediaItems = collection.media.filter((m) => Number(m.tmdbId) === tid);
      childItemsMatched += mediaItems.length;
    }

    for (const mediaItem of mediaItems) {
      const addedTime = new Date(mediaItem.addDate).getTime();
      if (Number.isNaN(addedTime)) {
        continue;
      }

      const daysSinceAdded = Math.floor((Date.now() - addedTime) / MS_PER_DAY);
      matches.push({
        collection,
        days: collection.deleteAfterDays - daysSinceAdded,
      });
    }
  }

  if (matches.length === 0) {
    return null;
  }

  // Item may be in multiple collections; the one acting soonest wins.
  const best = matches.reduce((min, curr) =>
    curr.days < min.days ? curr : min
  );
  return { ...best, childItemsMatched };
}

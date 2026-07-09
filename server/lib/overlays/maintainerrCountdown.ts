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
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

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
  ratingKey: string
): MaintainerrCountdown | null {
  const matches: MaintainerrCountdown[] = [];

  for (const collection of collections) {
    const deleteAfterDays = collection.deleteAfterDays;
    if (
      typeof deleteAfterDays !== 'number' ||
      !Number.isFinite(deleteAfterDays) ||
      deleteAfterDays <= 0
    ) {
      continue;
    }

    const mediaItem = collection.media.find((m) => {
      const id = m.mediaServerId || m.plexId?.toString();
      return id === ratingKey;
    });
    if (!mediaItem) {
      continue;
    }

    const addedTime = new Date(mediaItem.addDate).getTime();
    if (Number.isNaN(addedTime)) {
      continue;
    }

    const daysSinceAdded = Math.floor((Date.now() - addedTime) / MS_PER_DAY);
    matches.push({ collection, days: deleteAfterDays - daysSinceAdded });
  }

  if (matches.length === 0) {
    return null;
  }

  // Item may be in multiple collections; the one acting soonest wins.
  return matches.reduce((min, curr) => (curr.days < min.days ? curr : min));
}

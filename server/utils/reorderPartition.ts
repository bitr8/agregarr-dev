/**
 * Partitioning helpers for the universal reorder route.
 *
 * Reordering rewrites the whole config array as
 * `[...otherLibrary, ...accepted, ...hidden]`. Those groups must not overlap by
 * id, or a config ends up stored twice under the same id.
 */

export interface ReorderableConfig {
  id: string;
  libraryId: string | string[];
  sortOrderHome?: number;
  sortOrderLibrary?: number;
}

export type SortOrderField = 'sortOrderHome' | 'sortOrderLibrary';

export interface ReorderPartition<T> {
  /** Payload items that may be applied to this library. */
  accepted: T[];
  /** Saved configs belonging to another library. */
  otherLibrary: T[];
  /** Saved configs in this library that the payload did not mention. */
  hidden: T[];
  /** Payload items refused: they belong elsewhere, or repeat within the payload. */
  rejected: T[];
  /** Ids the saved array already stored more than once. Reported, not repaired. */
  duplicateIds: string[];
}

/**
 * A config may carry several library ids. Membership follows the first, which
 * is what the manual reorder path has always used.
 *
 * An empty array yields `undefined`, so such a config matches no library and is
 * preserved untouched rather than being reordered into one.
 */
export function resolveConfigLibraryId(
  libraryId: string | string[]
): string | undefined {
  return Array.isArray(libraryId) ? libraryId[0] : libraryId;
}

/**
 * Find the saved config a reordered item should inherit its untouched fields
 * from.
 *
 * Scoped to the library on purpose. Two saved configs can share an id while
 * living in different libraries, and an unscoped `find` returns whichever comes
 * first in the array. Merging from that one leaks the other library's
 * `collectionRatingKey`, sync schedule and sources into this config.
 *
 * Returns undefined for an id the payload introduced, so the caller falls back
 * to the supplied config.
 */
export function findSavedOriginal<T extends ReorderableConfig>(
  saved: T[],
  id: string,
  libraryId: string
): T | undefined {
  return saved.find(
    (config) =>
      config.id === id && resolveConfigLibraryId(config.libraryId) === libraryId
  );
}

/**
 * Split saved configs and an incoming reorder payload into groups that do not
 * overlap by id.
 *
 * A payload item is refused when no saved config with that id belongs to this
 * library. Without that check the config matches both `otherLibrary` (by its
 * stored library) and `accepted` (by being in the payload), and the rebuilt
 * array holds it twice. That is how two live collection configs ended up
 * sharing an id.
 *
 * Unknown ids are accepted, preserving the route's existing behaviour of
 * letting a reorder persist a config the caller supplied in full. A payload may
 * still only introduce one config per id.
 *
 * Ids the saved array already duplicated are reported but never repaired here.
 * Every saved config comes out exactly once. Deleting one is data repair, and a
 * reorder request is the wrong place to do it: the copies can belong to
 * different libraries, and there is no principled winner beyond array order.
 */
export function partitionForReorder<T extends ReorderableConfig>(
  saved: T[],
  payload: T[],
  libraryId: string
): ReorderPartition<T> {
  const savedIds = new Set<string>();
  const duplicateIds = new Set<string>();
  const idsInThisLibrary = new Set<string>();

  for (const config of saved) {
    if (savedIds.has(config.id)) {
      duplicateIds.add(config.id);
    }
    savedIds.add(config.id);

    if (resolveConfigLibraryId(config.libraryId) === libraryId) {
      idsInThisLibrary.add(config.id);
    }
  }

  const accepted: T[] = [];
  const rejected: T[] = [];
  const acceptedIds = new Set<string>();

  for (const item of payload) {
    const belongsElsewhere =
      savedIds.has(item.id) && !idsInThisLibrary.has(item.id);

    if (acceptedIds.has(item.id) || belongsElsewhere) {
      rejected.push(item);
      continue;
    }

    acceptedIds.add(item.id);
    accepted.push(item);
  }

  // Saved configs in other libraries pass through untouched, including any that
  // share an id with a config in this one. Dropping them would lose data.
  const otherLibrary = saved.filter(
    (config) => resolveConfigLibraryId(config.libraryId) !== libraryId
  );

  // An accepted item stands in for exactly one saved config. A second saved
  // config with the same id is unreachable, but deleting it here would be
  // repair, so it is carried through untouched.
  const represented = new Set<string>();
  const hidden = saved.filter((config) => {
    if (resolveConfigLibraryId(config.libraryId) !== libraryId) {
      return false;
    }
    if (acceptedIds.has(config.id) && !represented.has(config.id)) {
      represented.add(config.id);
      return false;
    }
    return true;
  });

  return {
    accepted,
    otherLibrary,
    hidden,
    rejected,
    duplicateIds: [...duplicateIds],
  };
}

/**
 * Rebuild this library's configs from a partition.
 *
 * Accepted items come from the request and carry only the fields the client
 * round-trips, so they are merged over their saved original. Hidden items are
 * saved configs the request never mentioned, so they pass through as they are.
 *
 * Merging a hidden item would be worse than pointless: for a shadowed duplicate
 * id, its "original" is the other copy, and spreading that copy first leaks any
 * field the shadowed one leaves unset.
 */
export function buildReorderedConfigs<T extends ReorderableConfig>(
  saved: T[],
  accepted: T[],
  hidden: T[],
  libraryId: string,
  sortOrderField: SortOrderField
): T[] {
  const merged = accepted.map((config, index) => {
    const original = findSavedOriginal(saved, config.id, libraryId);
    return {
      ...(original ?? config),
      ...config,
      [sortOrderField]: config[sortOrderField] ?? index,
    } as T;
  });

  const preserved = hidden.map(
    (config, index) =>
      ({
        ...config,
        [sortOrderField]: config[sortOrderField] ?? merged.length + index,
      } as T)
  );

  return [...merged, ...preserved];
}

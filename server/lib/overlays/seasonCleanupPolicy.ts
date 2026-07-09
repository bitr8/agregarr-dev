import type { PlexMetadataSafeResult } from '@server/api/plexMetadataClassify';

/**
 * What the season cleanup lifecycle should do with one tracked season row.
 *
 * Pure, so the policy that authorises destructive work (deleting a metadata row
 * and its stored base poster) is testable without a Plex client or a database.
 */
export type SeasonCleanupAction =
  /** Confirmed gone from Plex. Delete the stored base poster and the row. */
  | { action: 'untrack' }
  /**
   * Attempt the restore. Reached when the season resolved as ours, and ALSO when
   * the existence check was ambiguous: ambiguity means try to recover, never
   * destroy. Recovery data is deleted afterwards only if the upload succeeds.
   */
  | { action: 'restore'; title: string }
  /**
   * The rating key no longer identifies this season. Do nothing at all: an upload
   * would write our poster onto an unrelated item, and deleting the row would
   * discard recovery data on the strength of a key Plex has reused.
   */
  | {
      action: 'mismatch';
      foundType: string;
      foundLibrarySectionID: string | null;
    };

/**
 * Decide the action for a departed season, given the guarded Plex lookup.
 *
 * Identity must be POSITIVELY confirmed before any restore: the item is a season
 * AND it sits in the library whose row we hold. Plex reassigns rating keys when a
 * library is rebuilt, and a missing `librarySectionID` is doubt rather than
 * agreement - the season subpass already excludes such an item from the active
 * set, so cleanup must not treat it as a match either.
 */
export function classifySeasonCleanupAction(
  existence: PlexMetadataSafeResult,
  libraryId: string
): SeasonCleanupAction {
  if (existence.status === 'not_found') {
    return { action: 'untrack' };
  }

  if (existence.status === 'error') {
    // No metadata to identify or title it with. Maintainerr's revertItemInternal
    // attempts the restore on an inconclusive check rather than leaving the
    // overlay stuck, and a failed upload throws, so nothing is destroyed.
    return { action: 'restore', title: 'Season' };
  }

  const meta = existence.meta;
  const sectionId = meta.librarySectionID?.toString();

  if (meta.type !== 'season' || sectionId !== libraryId) {
    return {
      action: 'mismatch',
      foundType: meta.type,
      foundLibrarySectionID: sectionId ?? null,
    };
  }

  return { action: 'restore', title: meta.title };
}

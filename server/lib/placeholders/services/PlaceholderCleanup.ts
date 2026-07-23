import type PlexAPI from '@server/api/plexapi';
import { getRepository } from '@server/datasource';
import { ComingSoonItem } from '@server/entity/ComingSoonItem';
import type { LibraryItemsCache } from '@server/lib/collections/core/CollectionUtilities';
import type { MissingItem } from '@server/lib/collections/core/types';
import { getPlaceholderRootFolder } from '@server/lib/placeholders/helpers/placeholderPathHelpers';
import type { CollectionConfig } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import fs from 'fs/promises';
import path from 'path';
import { Like, Not } from 'typeorm';

/**
 * Single grace concept in the system: the number of days a record-less but
 * Agregarr-marked placeholder is left on disk (from `orphanedAt`) before the
 * global sweep may delete it, and the window a source-orphaned DB-tracked
 * placeholder is kept past its release/creation date. Hoisted here from a
 * function-local constant so the sweep (sites 4/5) and the record-driven
 * orphan window (site 7) share exactly one number.
 */
export const PLACEHOLDER_ORPHAN_GRACE_DAYS = 7;

/**
 * Run-scoped "this placeholder is still wanted" set. The creation pass records
 * every path it creates or resumes; the global sweep skips wanted paths before
 * ever stamping or deleting them, so a still-wanted quarantined placeholder is
 * never stamped in the first place (zero marker writes per sync in the steady
 * state). Purely advisory: losing it (process restart) degrades to one extra
 * stamp+clear cycle via the on-disk `orphanedAt` grace, never to a deletion.
 *
 * Keyed by `libraryKey|mediaType|relativePath` so the same title/year under a
 * different placeholder root cannot cross-suppress the sweep (round-5 §7).
 */
const WANTED_TTL_MS = 24 * 60 * 60 * 1000;
const recentlyWantedPlaceholders = new Map<string, number>();

function wantedKey(
  libraryKey: string,
  mediaType: 'movie' | 'tv',
  relativePath: string
): string {
  return `${libraryKey}|${mediaType}|${relativePath}`;
}

export function markPlaceholderWanted(
  libraryKey: string,
  mediaType: 'movie' | 'tv',
  relativePath: string
): void {
  recentlyWantedPlaceholders.set(
    wantedKey(libraryKey, mediaType, relativePath),
    Date.now()
  );
}

export function isPlaceholderWanted(
  libraryKey: string,
  mediaType: 'movie' | 'tv',
  relativePath: string
): boolean {
  const key = wantedKey(libraryKey, mediaType, relativePath);
  const ts = recentlyWantedPlaceholders.get(key);
  if (ts === undefined) {
    return false;
  }
  if (Date.now() - ts > WANTED_TTL_MS) {
    recentlyWantedPlaceholders.delete(key);
    return false;
  }
  return true;
}

/**
 * Resolve the placeholder root for a record's OWN config (round-5 C2). Strips a
 * multi-source `-source-<n>` suffix to the parent config, then maps its library
 * to the placeholder root. Legacy `libraryId` may be an array; the first library
 * whose root resolves wins. Returns undefined for a deleted/misconfigured config
 * so callers fall back to `marker` ownership (fail-closed) rather than binding a
 * db-record proof to the wrong root.
 */
export function rootOf(
  configId: string,
  mediaType: 'movie' | 'tv'
): string | undefined {
  const settings = getSettings();
  const parentId = configId.replace(/-source-\d+$/, '');
  const config = (settings.plex.collectionConfigs || []).find(
    (c) => c.id === parentId
  );
  if (!config) {
    return undefined;
  }
  return resolveRootFromLibraryId(config.libraryId, mediaType);
}

/**
 * Array-aware placeholder-root resolver from a config's libraryId. Use this
 * (with a CAPTURED config object) when settings may have already been mutated
 * to remove the config - e.g. the delete-collection route saves the trimmed
 * collectionConfigs before its cleanup loop, so rootOf(configId) would no longer
 * find it. Legacy libraryId may be an array; the first library whose root
 * resolves wins.
 */
export function resolveRootFromLibraryId(
  libraryId: string | string[] | undefined,
  mediaType: 'movie' | 'tv'
): string | undefined {
  const libraryIds = Array.isArray(libraryId) ? libraryId : [libraryId];
  for (const id of libraryIds) {
    if (!id) continue;
    const root = getPlaceholderRootFolder(id, mediaType);
    if (root) {
      return root;
    }
  }
  return undefined;
}

/**
 * Remove leftover placeholder remnants after the placeholder file itself is
 * gone: the .comingsoon marker, an empty Season 00 directory, and (for TV)
 * an empty show directory whose only remaining file is .plexmatch.
 * Best effort — directories with real content are left untouched.
 */
export async function cleanupPlaceholderRemnants(
  fullPath: string,
  mediaType: 'movie' | 'tv'
): Promise<void> {
  try {
    const parentDir = path.dirname(fullPath);

    // Remove placeholder-owned metadata files so the directory reads as empty.
    for (const metaFile of ['.comingsoon', '.plexmatch']) {
      try {
        await fs.unlink(path.join(parentDir, metaFile));
      } catch {
        // File already gone or never created
      }
    }

    // Clean up an orphaned .trickplay sidecar directory left for the
    // deleted placeholder video
    if (fullPath.endsWith('.mp4')) {
      try {
        await fs.rm(fullPath.replace(/\.mp4$/, '.trickplay'), {
          recursive: true,
        });
      } catch {
        // Sidecar doesn't exist
      }
    }

    const parentFiles = await fs.readdir(parentDir);
    if (parentFiles.length === 0) {
      await fs.rmdir(parentDir);
      if (mediaType === 'tv') {
        const grandParentDir = path.dirname(parentDir);
        let gpFiles = await fs.readdir(grandParentDir);
        if (gpFiles.length === 1 && gpFiles[0] === '.plexmatch') {
          await fs.unlink(path.join(grandParentDir, '.plexmatch'));
          gpFiles = [];
        }
        if (gpFiles.length === 0) {
          await fs.rmdir(grandParentDir);
        }
      }
    }
  } catch {
    // Best effort — directory may not be empty or already gone
  }
}

/**
 * Helper function to clean up a placeholder when real content is detected.
 * Removes the Plex label, deletes the placeholder file, and deletes ALL
 * database records for this TMDB ID across all collections.
 */
export async function cleanupPlaceholderForRealContent(
  tmdbId: number,
  placeholderPath: string,
  mediaType: 'movie' | 'tv',
  plexClient?: PlexAPI,
  plexRatingKey?: string
): Promise<boolean> {
  const { removePlaceholder, resolveRecordPath } = await import(
    '@server/lib/placeholders/placeholderManager'
  );
  const repository = getRepository(ComingSoonItem);

  // C1: true when the on-disk file was unlinked OR was already gone (goal state
  // reached); false on an EOWNERSHIP-skip (file kept). Callers enqueue ghost
  // cleanup only on true, so a refused real file is never touched by Sink 2.
  let fileDeleted = false;

  try {
    if (plexClient && plexRatingKey) {
      try {
        await plexClient.removeLabelFromItem(
          plexRatingKey,
          'trailer-placeholder'
        );
        logger.info('Removed trailer-placeholder label from Plex item', {
          label: 'PlaceholderService',
          tmdbId,
          ratingKey: plexRatingKey,
        });
      } catch (error) {
        logger.warn(
          'Failed to remove placeholder label — continuing with file/DB cleanup',
          {
            label: 'PlaceholderService',
            tmdbId,
            ratingKey: plexRatingKey,
            error: error instanceof Error ? error.message : 'Unknown error',
          }
        );
      }

      // Also check DB for other ratingKeys that may have the label
      // (handles separate Plex entries for placeholder vs real content).
      // C5: scope by mediaType — a movie tmdbId N and a TV tmdbId N are
      // unrelated titles. Tolerate a missing table (first run) - degrade to []
      // rather than aborting the whole cleanup.
      let dbRecords: ComingSoonItem[] = [];
      try {
        dbRecords = await repository.find({ where: { tmdbId, mediaType } });
      } catch {
        dbRecords = [];
      }
      for (const record of dbRecords) {
        if (record.plexRatingKey && record.plexRatingKey !== plexRatingKey) {
          try {
            await plexClient.removeLabelFromItem(
              record.plexRatingKey,
              'trailer-placeholder'
            );
            logger.info(
              'Removed trailer-placeholder label from placeholder Plex entry',
              {
                label: 'PlaceholderService',
                tmdbId,
                ratingKey: record.plexRatingKey,
              }
            );
          } catch {
            // Best effort — placeholder entry may already be gone
          }
        }
      }
    }

    // Isolate the record fetch so a missing table (first run) degrades to
    // marker mode instead of aborting the whole cleanup. Scope by mediaType.
    let records: ComingSoonItem[] = [];
    try {
      records = await repository.find({ where: { tmdbId, mediaType } });
    } catch (fetchError) {
      logger.debug(
        'Placeholder record fetch failed - proceeding in marker mode',
        {
          label: 'PlaceholderService',
          tmdbId,
          mediaType,
          error:
            fetchError instanceof Error
              ? fetchError.message
              : String(fetchError),
        }
      );
      records = [];
    }

    // C2: bind a record ONLY if its own-config-root-resolved absolute path
    // equals the requested absolute path. A record under a different root can
    // no longer authorise deleting a same-relative-path file scanned elsewhere.
    const norm = (p: string) => path.resolve(p).replace(/\\/g, '/');
    const target = norm(placeholderPath);
    let boundAbs: string | undefined;
    const boundRecord = records.find((r) => {
      const root = rootOf(r.configId, r.mediaType);
      if (!root) return false;
      const abs = resolveRecordPath(root, r.placeholderPath);
      if (norm(abs) === target) {
        boundAbs = abs;
        return true;
      }
      return false;
    });

    try {
      if (boundRecord && boundAbs) {
        // Covers every DB-tracked (incl. legacy marker-less) placeholder.
        await removePlaceholder(boundAbs, mediaType, {
          source: 'db-record',
          record: boundRecord,
          recordAbsPath: boundAbs,
        });
      } else {
        // No bound record: require the on-disk marker (real media sharing
        // placeholder naming, or a legacy untracked placeholder, fails here).
        await removePlaceholder(placeholderPath, mediaType, {
          source: 'marker',
          expectedTmdbId: tmdbId,
        });
      }
      fileDeleted = true;

      logger.info('Deleted placeholder file - real content detected', {
        label: 'PlaceholderService',
        tmdbId,
        mediaType,
        placeholderPath,
      });
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;

      if (code === 'ENOENT') {
        // File already gone. Goal state reached — clean remnants, then proceed
        // to DB record deletion.
        logger.info(
          'Placeholder file already gone - cleaning up remnants and database records',
          {
            label: 'PlaceholderService',
            tmdbId,
            mediaType,
            placeholderPath,
          }
        );
        await cleanupPlaceholderRemnants(placeholderPath, mediaType);
        fileDeleted = true;
      } else if (code === 'EOWNERSHIP') {
        // Not provably ours (real media sharing placeholder naming, or a legacy
        // untracked placeholder). Skip BOTH the unlink AND the tmdbId-wide DB
        // delete — deleting all records here would strand a genuine placeholder
        // for the same tmdbId at a different path as a record-less orphan.
        logger.warn(
          'Not provably an Agregarr placeholder (possible real media sharing placeholder naming, or a legacy untracked placeholder) - leaving file on disk and keeping DB records',
          {
            label: 'PlaceholderService',
            tmdbId,
            mediaType,
            placeholderPath,
          }
        );
        return false;
      } else {
        throw error;
      }
    }

    // tmdbId-wide DB delete, scoped by mediaType (C5). Unreachable on EOWNERSHIP.
    const allRecords = await repository.find({ where: { tmdbId, mediaType } });

    if (allRecords.length > 0) {
      await repository.delete({ tmdbId, mediaType });

      logger.info(
        'Deleted placeholder database records across all collections',
        {
          label: 'PlaceholderService',
          tmdbId,
          mediaType,
          recordsDeleted: allRecords.length,
          collections: allRecords.map((r) => r.configId),
        }
      );
    }

    return fileDeleted;
  } catch (error) {
    logger.error('Failed to clean up placeholder for real content', {
      label: 'PlaceholderService',
      tmdbId,
      mediaType,
      placeholderPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return fileDeleted;
  }
}

/**
 * Handle placeholder operations based on createPlaceholdersForMissing setting
 * - If enabled: runs cleanup (released items, orphaned items, stuck records)
 * - If disabled: deletes all placeholder records for the config
 * Files will be cleaned up later by orphaned file cleanup
 */
export async function handlePlaceholderCleanup(
  config: CollectionConfig,
  plexClient: PlexAPI,
  libraryCache?: LibraryItemsCache,
  sourceTmdbIds?: Set<number>
): Promise<void> {
  logger.debug('handlePlaceholderCleanup called', {
    label: 'PlaceholderService',
    configId: config.id,
    configName: config.name,
    createPlaceholdersForMissing: config.createPlaceholdersForMissing,
    willDeleteAll: !config.createPlaceholdersForMissing,
  });

  if (config.createPlaceholdersForMissing) {
    // Setting enabled - run normal cleanup
    await cleanupPlaceholdersForConfig(
      config,
      plexClient,
      libraryCache,
      sourceTmdbIds
    );
  } else {
    // Setting disabled - delete all placeholders for this config
    await deleteAllPlaceholdersForConfig(config.id);
  }
}

/**
 * Delete all placeholder records for a config when createPlaceholdersForMissing is disabled
 * Files will be cleaned up later by orphaned file cleanup
 */
export async function deleteAllPlaceholdersForConfig(
  configId: string
): Promise<void> {
  try {
    const repository = getRepository(ComingSoonItem);

    // Find all placeholders for this config (including multi-source sub-configs)
    const placeholders = await repository.find({
      where: [
        { configId },
        { configId: Like(`${configId}-source-%`) }, // Multi-source sub-collections
      ],
    });

    if (placeholders.length === 0) {
      return;
    }

    logger.info(
      `Deleting ${placeholders.length} placeholder records for config with createPlaceholdersForMissing disabled`,
      {
        label: 'PlaceholderService',
        configId,
        count: placeholders.length,
      }
    );

    await repository.remove(placeholders);

    logger.info('Placeholder records deleted successfully', {
      label: 'PlaceholderService',
      configId,
      removed: placeholders.length,
    });
  } catch (error) {
    logger.error('Failed to delete placeholder records for config', {
      label: 'PlaceholderService',
      configId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Cleanup orphaned placeholder DB records where the collection no longer exists
 * This runs during full sync to clean up records from deleted collections
 */
export async function cleanupOrphanedPlaceholderRecords(): Promise<void> {
  try {
    const repository = getRepository(ComingSoonItem);
    const settings = getSettings();

    // Get all active collection config IDs
    const activeConfigs = settings.plex.collectionConfigs || [];
    const activeConfigIds = new Set(activeConfigs.map((c) => c.id));

    // Get all placeholder records
    const allRecords = await repository.find();

    logger.debug('Starting orphaned placeholder record cleanup', {
      label: 'PlaceholderService',
      totalRecords: allRecords.length,
      activeConfigCount: activeConfigs.length,
      sampleConfigIds: allRecords.slice(0, 5).map((r) => r.configId),
    });

    if (allRecords.length === 0) {
      logger.debug('No placeholder records in database', {
        label: 'PlaceholderService',
      });
      return;
    }

    // Find orphaned records
    const orphanedRecords = allRecords.filter((record) => {
      // Check if configId exists in active configs
      if (activeConfigIds.has(record.configId)) {
        return false;
      }

      // For multi-source sub-collections (e.g., "33079-source-1762115269335")
      // Check if the parent config exists
      const match = record.configId.match(/^(\d+)-source-/);
      if (match) {
        const parentId = match[1];
        logger.debug('Checking multi-source placeholder record', {
          label: 'PlaceholderService',
          recordConfigId: record.configId,
          extractedParentId: parentId,
          parentExists: activeConfigIds.has(parentId),
          activeConfigIds: Array.from(activeConfigIds),
        });
        if (activeConfigIds.has(parentId)) {
          return false; // Parent exists, keep record
        }
      } else if (record.configId.includes('-source-')) {
        // Log if we have a source ID but regex didn't match
        logger.warn('Multi-source configId did not match regex pattern', {
          label: 'PlaceholderService',
          recordConfigId: record.configId,
          regexPattern: '/^(\\d+)-source-/',
        });
      }

      return true; // No matching config found - orphaned
    });

    if (orphanedRecords.length === 0) {
      logger.debug('No orphaned placeholder records found', {
        label: 'PlaceholderService',
        totalRecords: allRecords.length,
      });
      return;
    }

    logger.info(
      `Found ${orphanedRecords.length} orphaned placeholder records to clean up`,
      {
        label: 'PlaceholderService',
        orphanedCount: orphanedRecords.length,
        totalRecords: allRecords.length,
      }
    );

    // Delete orphaned records (files will be cleaned up separately)
    await repository.remove(orphanedRecords);

    logger.info('Orphaned placeholder records cleaned up', {
      label: 'PlaceholderService',
      removed: orphanedRecords.length,
    });
  } catch (error) {
    logger.error('Failed to cleanup orphaned placeholder records', {
      label: 'PlaceholderService',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * A ghost to clean up: either a specific placeholder file whose Plex entry may
 * linger, or a bare directory to re-scan. File entries carry the mediaType (so
 * the scoped-scan fallback knows show-folder vs movie-folder) and an optional
 * pre-resolved episode ratingKey.
 */
export type GhostDeletion =
  | { filePath: string; mediaType: 'movie' | 'tv'; plexRatingKey?: string }
  | { directory: string };

/**
 * The ONLY sanctioned path to plexClient.deleteItem for placeholder cleanup
 * (Sink 2). Deletes the Plex item ONLY when every one of its Media file parts
 * is (a) under a configured placeholder root AND (b) absent from disk. Any part
 * that still exists, sits outside a managed root, or cannot be checked means
 * REFUSE — a lingering ghost is acceptable; deleting a live/real/merged item is
 * not. This single invariant supersedes a filename/marker heuristic and never
 * trusts a caller-supplied "these were deleted" list.
 *
 * Containment is LEXICAL: a genuine dead ghost's file is absent, so fs.realpath
 * would throw ENOENT and over-refuse; we resolve the roots once (they exist) and
 * prefix-match the normalised part path. Existence is checked with fs.access.
 *
 * @returns true only if the item was deleted.
 */
export async function safeDeletePlaceholderPlexItem(
  plexClient: PlexAPI,
  ratingKey: string,
  reason: string
): Promise<boolean> {
  let metadata;
  try {
    metadata = await plexClient.getMetadata(ratingKey);
  } catch (error) {
    logger.debug('Refusing Plex deletion — metadata fetch failed', {
      label: 'PlaceholderCleanup',
      ratingKey,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  if (!metadata) {
    // getMetadata can resolve to undefined (Metadata[0] of an empty container);
    // touching .Media would throw OUTSIDE the try and abort the ghost batch.
    logger.debug('Refusing Plex deletion — no metadata returned', {
      label: 'PlaceholderCleanup',
      ratingKey,
      reason,
    });
    return false;
  }

  const parts: string[] = [];
  for (const media of metadata.Media ?? []) {
    for (const part of media.Part ?? []) {
      if (part.file) parts.push(part.file);
    }
  }
  if (parts.length === 0) {
    // Cannot prove it is a dead placeholder ghost (a ghost has file parts we can
    // confirm are gone). Fail safe.
    logger.debug('Refusing Plex deletion — item has no file parts', {
      label: 'PlaceholderCleanup',
      ratingKey,
      reason,
    });
    return false;
  }

  // Resolve every configured placeholder root once (roots exist on disk).
  const settings = getSettings();
  const rootMap = {
    ...(settings.main.placeholderMovieRootFolders ?? {}),
    ...(settings.main.placeholderTVRootFolders ?? {}),
  };
  const realRoots: string[] = [];
  for (const root of Object.values(rootMap)) {
    try {
      realRoots.push(await fs.realpath(root));
    } catch {
      // Root unresolvable (mount blip) — do not include; parts under it will
      // then fail containment and the whole deletion refuses.
    }
  }
  if (realRoots.length === 0) {
    logger.debug('Refusing Plex deletion — no placeholder root resolvable', {
      label: 'PlaceholderCleanup',
      ratingKey,
      reason,
    });
    return false;
  }

  const norm = (p: string) => path.resolve(p).replace(/\\/g, '/');
  const normRoots = realRoots.map((r) => ({ real: r, norm: norm(r) }));
  const rootsInvolved = new Set<string>();

  for (const partPath of parts) {
    const p = norm(partPath);
    const matched = normRoots.find(
      (r) => p === r.norm || p.startsWith(`${r.norm}/`)
    );
    if (!matched) {
      // A part outside all managed roots — not ours to judge (different mount
      // namespace, or real media). Refuse.
      logger.debug('Refusing Plex deletion — a part is outside managed roots', {
        label: 'PlaceholderCleanup',
        ratingKey,
        reason,
        part: partPath,
      });
      return false;
    }
    rootsInvolved.add(matched.real);

    try {
      await fs.access(partPath);
      // File still exists → real media, or a merged item whose real part
      // survives. Either way, deleting the Plex entry would delete real content.
      logger.debug('Refusing Plex deletion — a placeholder part still exists', {
        label: 'PlaceholderCleanup',
        ratingKey,
        reason,
        part: partPath,
      });
      return false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // Permission/mount error — cannot prove absence. Refuse.
        logger.debug('Refusing Plex deletion — cannot check a part on disk', {
          label: 'PlaceholderCleanup',
          ratingKey,
          reason,
          part: partPath,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      // ENOENT → part is absent (the intended dead-ghost state).
    }
  }

  // Mount-present precondition: absence only proves "deleted" if the root is
  // actually mounted. An empty/unreadable root means Agregarr sees ENOENT while
  // Plex's file may exist — refuse all deletions resolving under it (mount blip).
  // RESIDUAL: this catches a whole-root stale mount, not a stale SUBPATH under a
  // populated shared root (placeholder root == real media library root is a
  // supported config). There, a dropped submount could make a real part read
  // ENOENT while the root readdir stays non-empty. This lives inside the plan's
  // documented identical-mount assumption; a merged item's surviving real part
  // normally still blocks deletion via the fs.access check above, so both parts
  // would have to be stale simultaneously. Not closed here (a per-part
  // parent-dir readdir would refuse every legit folder-removed ghost too).
  for (const root of rootsInvolved) {
    try {
      const entries = await fs.readdir(root);
      if (entries.length === 0) {
        logger.warn(
          'Refusing Plex deletion — placeholder root empty (mount?)',
          {
            label: 'PlaceholderCleanup',
            ratingKey,
            reason,
            root,
          }
        );
        return false;
      }
    } catch (error) {
      logger.warn('Refusing Plex deletion — placeholder root unreadable', {
        label: 'PlaceholderCleanup',
        ratingKey,
        reason,
        root,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  try {
    await plexClient.deleteItem(ratingKey);
    logger.info(
      'Deleted stale Plex ghost item — all placeholder parts absent',
      {
        label: 'PlaceholderCleanup',
        ratingKey,
        reason,
      }
    );
    return true;
  } catch (error) {
    logger.warn('Failed to delete Plex ghost item', {
      label: 'PlaceholderCleanup',
      ratingKey,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Remove ghost Plex entries left behind by deleted placeholder files.
 *
 * Direct deletion first: every candidate routes through
 * safeDeletePlaceholderPlexItem (the Sink-2 gate), which only deletes a Plex
 * item whose placeholder file parts are all gone. Anything the gate can't
 * resolve or refuses (no match, a surviving/merged part) falls back to a
 * directory-SCOPED Plex scan — never a whole-library scan, so Plex's
 * empty-trash-after-scan can't sweep unrelated missing items. emptyTrash stays
 * a last resort behind the same three guards as before.
 *
 * Placeholder roots are assumed to be mounted identically in Agregarr and Plex
 * (the same assumption findItemsByFilePaths relies on).
 *
 * @returns count of items deleted directly via the gate.
 */
export async function removeGhostEntries(
  plexClient: PlexAPI,
  libraryId: string,
  deletions: GhostDeletion[]
): Promise<{ directlyDeleted: number }> {
  if (deletions.length === 0) {
    return { directlyDeleted: 0 };
  }

  const fileEntries = deletions.filter(
    (
      d
    ): d is {
      filePath: string;
      mediaType: 'movie' | 'tv';
      plexRatingKey?: string;
    } => 'filePath' in d
  );
  const dirEntries = deletions.filter(
    (d): d is { directory: string } => 'directory' in d
  );

  // TV placeholder files live in <show>/Season 00/ — scope a fallback scan to
  // the show folder. Movie placeholders sit directly in the movie folder.
  const scanDirFor = (filePath: string, mediaType: 'movie' | 'tv') =>
    mediaType === 'tv'
      ? path.dirname(path.dirname(filePath))
      : path.dirname(filePath);

  let directlyDeleted = 0;
  const missedDirectories = new Set<string>();

  // 1) Pre-resolved ratingKeys (TV episodes resolved before file deletion).
  for (const entry of fileEntries) {
    if (!entry.plexRatingKey) continue;
    const deleted = await safeDeletePlaceholderPlexItem(
      plexClient,
      entry.plexRatingKey,
      'ghost placeholder cleanup (pre-resolved)'
    );
    if (deleted) {
      directlyDeleted++;
    } else {
      missedDirectories.add(scanDirFor(entry.filePath, entry.mediaType));
    }
  }

  // 2) Resolve remaining file entries by path, grouped by mediaType so TV
  //    lookups can pass plexType 4 (episodes).
  const unresolved = fileEntries.filter((e) => !e.plexRatingKey);
  for (const [mediaType, plexType] of [
    ['movie', undefined],
    ['tv', 4],
  ] as const) {
    const group = unresolved.filter((e) => e.mediaType === mediaType);
    if (group.length === 0) continue;

    const paths = new Set(group.map((e) => e.filePath));
    let matched: Map<string, string[]>;
    try {
      matched = await plexClient.findItemsByFilePaths(
        libraryId,
        paths,
        plexType
      );
    } catch (error) {
      for (const e of group) {
        missedDirectories.add(scanDirFor(e.filePath, e.mediaType));
      }
      logger.warn('Failed to resolve ghost Plex items by path', {
        label: 'PlaceholderCleanup',
        libraryId,
        mediaType,
        pathCount: group.length,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    for (const entry of group) {
      const keys = matched.get(entry.filePath);
      if (!keys || keys.length === 0) {
        missedDirectories.add(scanDirFor(entry.filePath, entry.mediaType));
        continue;
      }
      let anyDeleted = false;
      for (const key of keys) {
        const deleted = await safeDeletePlaceholderPlexItem(
          plexClient,
          key,
          'ghost placeholder cleanup (by-path)'
        );
        if (deleted) {
          directlyDeleted++;
          anyDeleted = true;
        }
      }
      // Gate refused every match (e.g. a merged item whose real part survives):
      // a scoped scan lets Plex drop only the missing placeholder part.
      if (!anyDeleted) {
        missedDirectories.add(scanDirFor(entry.filePath, entry.mediaType));
      }
    }
  }

  // 3) Pool bare directory entries.
  for (const d of dirEntries) {
    missedDirectories.add(d.directory);
  }

  if (missedDirectories.size === 0) {
    return { directlyDeleted };
  }

  // 4) Scoped scans only. A directory produces a useful scan only if Plex can
  //    resolve it (strictly below a section location). Out-of-section dirs get
  //    a single warn and are left to the user's own scheduled scan — never a
  //    full-library scan (deleted outright so auto-empty-trash has nothing
  //    library-wide to piggyback on).
  const sectionPaths = await plexClient.getLibrarySectionPaths(libraryId);
  const isInsideSection = (directory: string): boolean =>
    sectionPaths.length === 0 ||
    sectionPaths.some(
      (root) =>
        directory !== root &&
        directory.startsWith(root.endsWith('/') ? root : `${root}/`)
    );

  let scansTriggered = 0;
  let outsideSection = 0;
  for (const directory of missedDirectories) {
    if (!isInsideSection(directory)) {
      outsideSection++;
      continue;
    }
    try {
      await plexClient.scanLibrary(libraryId, directory);
      scansTriggered++;
    } catch (error) {
      logger.warn('Scoped Plex scan failed for directory', {
        label: 'PlaceholderCleanup',
        libraryId,
        directory,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (outsideSection > 0) {
    logger.warn(
      'Ghost entry may linger until your own scheduled Plex scan — Agregarr and Plex appear to mount the placeholder root on different paths',
      {
        label: 'PlaceholderCleanup',
        libraryId,
        outsideSection,
        sectionPaths,
      }
    );
  }

  // emptyTrash: last resort behind the same three guards. Direct deletion now
  // handles the overwhelming majority, so this path is near-dead; log loudly
  // when it fires because it is library-wide (residual §12.1).
  if (
    scansTriggered > 0 &&
    getSettings().plex.autoEmptyTrash !== false &&
    !(await plexClient.getAutoEmptyTrashEnabled())
  ) {
    logger.warn(
      'Emptying Plex trash for the whole library after scoped ghost scans — any items independently in trash will be purged. Enable "Allow media deletion" in Plex to let Agregarr delete ghost entries directly instead.',
      { label: 'PlaceholderCleanup', libraryId }
    );
    // Brief delay so the scans can mark missing files before purging.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await plexClient.emptyTrash(libraryId);
  }

  return { directlyDeleted };
}

/**
 * Remove stale Plex entries for deleted placeholder files. Thin adapter over
 * removeGhostEntries: groups the deleted paths by library and routes every
 * candidate (pre-resolved ratingKey or by-path match) through the Sink-2 gate,
 * with the same scoped-scan fallback. The direct-deletion logic lives once, in
 * removeGhostEntries.
 *
 * @param plexClient - Plex API client
 * @param deletedPaths - Paths of deleted placeholder files with library metadata
 * @returns Count of directly deleted Plex items
 */
export async function cleanupStalePlexEntries(
  plexClient: PlexAPI,
  deletedPaths: OrphanedFileCleanupResult['deletedPaths']
): Promise<number> {
  const byLibrary = new Map<string, GhostDeletion[]>();
  for (const deleted of deletedPaths) {
    const list = byLibrary.get(deleted.libraryKey) ?? [];
    list.push({
      filePath: deleted.fullPath,
      mediaType: deleted.mediaType,
      plexRatingKey: deleted.plexRatingKey,
    });
    byLibrary.set(deleted.libraryKey, list);
  }

  let directlyDeleted = 0;
  for (const [libraryKey, deletions] of byLibrary) {
    try {
      const result = await removeGhostEntries(
        plexClient,
        libraryKey,
        deletions
      );
      directlyDeleted += result.directlyDeleted;
    } catch (error) {
      logger.warn('Plex ghost cleanup failed for library', {
        label: 'PlaceholderCleanup',
        libraryKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info('Plex cleanup completed', {
    label: 'PlaceholderCleanup',
    deletedPaths: deletedPaths.length,
    directlyDeleted,
  });

  return directlyDeleted;
}

export interface OrphanedFileCleanupResult {
  filesRemoved: number;
  deletedPaths: {
    fullPath: string;
    relativePath: string;
    libraryKey: string;
    mediaType: 'movie' | 'tv';
    plexRatingKey?: string;
  }[];
}

/**
 * Decide-and-delete for one record-less, Agregarr-marked placeholder file in
 * the global sweep. Fail-safe throughout:
 *  - still wanted this run          -> 'kept' (never touched)
 *  - no/unparseable marker          -> 'unproven' (never deleted; leak tier)
 *  - marker present, no orphanedAt  -> stamp it, 'kept' (grace window starts)
 *  - stamp write failed             -> 'kept' (no persisted grace = no delete)
 *  - within the grace window        -> 'kept'
 *  - re-tracked since the stamp     -> 'kept' (adoption won the race)
 *  - past grace, still untracked    -> delete via the marker gate ('deleted')
 *  - gate refuses (EOWNERSHIP)      -> 'unproven'
 */
async function sweepRecordlessPlaceholder(
  filePath: string,
  relativePath: string,
  libraryKey: string,
  mediaType: 'movie' | 'tv',
  expectedTmdbId: number | undefined
): Promise<'deleted' | 'kept' | 'unproven'> {
  const {
    removePlaceholder,
    readPlaceholderMarker,
    stampMarkerOrphaned,
    clearMarkerOrphaned,
  } = await import('@server/lib/placeholders/placeholderManager');

  // 1. Still wanted this run (created or resumed): never stamp or delete.
  if (isPlaceholderWanted(libraryKey, mediaType, relativePath)) {
    return 'kept';
  }

  const markerDir = path.dirname(filePath);

  // 2. Require a parseable Agregarr marker (no marker => leak tier, never delete).
  const marker = await readPlaceholderMarker(markerDir);
  if (!marker) {
    return 'unproven';
  }

  // 3. orphanedAt grace window.
  if (!marker.orphanedAt) {
    // First record-less sighting: start the grace clock, keep the file. If the
    // stamp write fails (read-only mount), no grace start persists, so the file
    // stays kept next sync too (fail-safe: no delete without a persisted start).
    await stampMarkerOrphaned(markerDir);
    return 'kept';
  }
  const orphanedMs = new Date(marker.orphanedAt).getTime();
  if (Number.isNaN(orphanedMs)) {
    // Corrupt timestamp (external tampering; Agregarr writes valid ISO). Clear
    // it so the next sweep re-stamps a fresh grace start - stampMarkerOrphaned
    // would no-op here (it early-returns on any truthy orphanedAt), leaving the
    // file permanently 'kept'.
    await clearMarkerOrphaned(markerDir);
    return 'kept';
  }
  const ageDays = Math.floor((Date.now() - orphanedMs) / (24 * 60 * 60 * 1000));
  if (ageDays < PLACEHOLDER_ORPHAN_GRACE_DAYS) {
    return 'kept';
  }

  // 4. Fresh DB re-check: a record created after the stamp always wins the race.
  const repository = getRepository(ComingSoonItem);
  const nowTracked = await repository.findOne({
    where: { placeholderPath: relativePath },
  });
  if (nowTracked) {
    return 'kept';
  }

  // 5. Delete via the marker gate (verifies the marker + tmdbId in-sink).
  try {
    await removePlaceholder(filePath, mediaType, {
      source: 'marker',
      expectedTmdbId,
    });
    return 'deleted';
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code === 'ENOENT') {
      await cleanupPlaceholderRemnants(filePath, mediaType);
      return 'deleted';
    }
    if (code === 'EOWNERSHIP') {
      return 'unproven';
    }
    throw error;
  }
}

/**
 * Back-fill the `.comingsoon` marker for EVERY DB-tracked placeholder that is
 * missing it on disk. Runs once per sync, iterating the coming_soon_item table
 * directly - deliberately independent of the orphan-adoption scan
 * (`getLibraryContents` returns only the library's first page, so that scan
 * back-fills at most the first ~50 items). A DB record is PROOF of Agregarr
 * ownership, so this is additive and non-destructive: `backfillPlaceholderMarker`
 * only ever writes an ABSENT marker beside an existing tracked file (create-only
 * 'wx'), never deletes, never infers ownership from filename tokens, never
 * touches real media. It changes NO deletion decision in the current sync - it
 * runs AFTER the cleanup steps, and the markers it writes are only read by the
 * next sync's sweep. Net effect: the legacy marker-less tier converges onto
 * markers over time so the marker gate + grace cleanup can manage every tracked
 * placeholder, not just those in a library's first page.
 */
export async function backfillAllTrackedPlaceholderMarkers(): Promise<void> {
  try {
    const repository = getRepository(ComingSoonItem);
    const records = await repository.find();
    if (records.length === 0) {
      return;
    }
    const { backfillPlaceholderMarker } = await import(
      '@server/lib/placeholders/services/PlaceholderCreation'
    );
    let backfilled = 0;
    for (const record of records) {
      // Per-record isolation: one malformed row (e.g. a hand-edited or null
      // placeholderPath) must not abort the whole pass. repository.find()
      // returns a stable order, so an unguarded throw would starve every later
      // record on EVERY sync - silently defeating the fix for the legacy fleet
      // it exists to serve. backfillPlaceholderMarker is designed non-throwing,
      // but its path helpers can still throw on corrupt input.
      try {
        if (await backfillPlaceholderMarker(record)) {
          backfilled++;
        }
      } catch (error) {
        logger.debug('Back-fill skipped a record - continuing', {
          label: 'PlaceholderService',
          tmdbId: record.tmdbId,
          title: record.title,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (backfilled > 0) {
      logger.info(
        'Back-filled .comingsoon markers for DB-tracked placeholders missing them',
        {
          label: 'PlaceholderService',
          backfilled,
          totalTracked: records.length,
        }
      );
    }
  } catch (error) {
    logger.warn(
      'Marker back-fill pass failed - non-fatal, tracked placeholders retry next sync',
      {
        label: 'PlaceholderService',
        error: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

/**
 * Cleanup orphaned placeholder files where no DB records reference them
 * This runs after record cleanup to remove files that are no longer tracked
 * @returns Cleanup result with count and paths of deleted files
 */
export async function cleanupOrphanedPlaceholderFiles(
  plexClient?: PlexAPI
): Promise<OrphanedFileCleanupResult> {
  try {
    const repository = getRepository(ComingSoonItem);
    const settings = getSettings();
    const { getPlaceholderRootFolder } = await import(
      '@server/lib/placeholders/helpers/placeholderPathHelpers'
    );

    // Get all library-specific placeholder folders
    const libraryPaths: {
      path: string;
      type: 'movie' | 'tv';
      libraryKey: string;
    }[] = [];

    for (const library of settings.plex.libraries) {
      if (library.type !== 'movie' && library.type !== 'show') continue;

      const mediaType: 'movie' | 'tv' =
        library.type === 'movie' ? 'movie' : 'tv';
      const placeholderPath = getPlaceholderRootFolder(library.key, mediaType);
      if (placeholderPath) {
        libraryPaths.push({
          path: placeholderPath,
          type: mediaType,
          libraryKey: library.key,
        });
      }
    }

    if (libraryPaths.length === 0) {
      logger.debug(
        'No placeholder library paths configured, skipping file cleanup',
        {
          label: 'PlaceholderService',
        }
      );
      return { filesRemoved: 0, deletedPaths: [] };
    }

    // Get all placeholder file paths from database
    const allRecords = await repository.find();

    logger.debug('Starting orphaned placeholder file cleanup', {
      label: 'PlaceholderService',
      totalRecordsInDatabase: allRecords.length,
      samplePaths: allRecords.slice(0, 5).map((r) => r.placeholderPath),
    });

    // Legacy rows may store an ABSOLUTE placeholderPath (§6d). Add the
    // root-stripped relative variant so such a file is not seen as orphaned
    // (scan-derived relativePaths are relative to the library root).
    const trackedPaths = new Set<string>();
    for (const r of allRecords) {
      trackedPaths.add(r.placeholderPath);
      if (path.isAbsolute(r.placeholderPath)) {
        for (const lib of libraryPaths) {
          if (r.placeholderPath.startsWith(lib.path + path.sep)) {
            trackedPaths.add(path.relative(lib.path, r.placeholderPath));
          }
        }
      }
    }

    let filesRemoved = 0;
    const deletedPaths: OrphanedFileCleanupResult['deletedPaths'] = [];

    // Scan each library's placeholder folder for orphaned files
    for (const libraryInfo of libraryPaths) {
      // Per-library tally of record-less files we refused to delete (no
      // ownership marker), logged once as an aggregate so a large legacy fleet
      // never produces per-file warn spam.
      let skippedUnproven = 0;
      const unprovenSamples: string[] = [];
      try {
        if (libraryInfo.type === 'movie') {
          // Scan movie library for orphaned files
          const movieFolders = await fs.readdir(libraryInfo.path);

          for (const folder of movieFolders) {
            const folderPath = path.join(libraryInfo.path, folder);

            try {
              const stats = await fs.stat(folderPath);
              if (!stats.isDirectory()) continue;

              const files = await fs.readdir(folderPath);
              for (const file of files) {
                // Check if this is a placeholder file. Older Agregarr versions
                // used {edition-Placeholder} and {edition-Coming Soon} before
                // the rename to {edition-Trailer}, so legacy files must also
                // be matched or they accumulate forever.
                if (
                  !file.includes('{edition-Trailer}') &&
                  !file.includes('{edition-Placeholder}') &&
                  !file.includes('{edition-Coming Soon}')
                )
                  continue;

                const filePath = path.join(folderPath, file);

                // Skip directories (Plex creates .trickplay folders with same base name)
                try {
                  const fileStat = await fs.stat(filePath);
                  if (!fileStat.isFile()) continue;
                } catch {
                  continue; // Can't stat, skip
                }
                const relativePath = path.join(folder, file);

                // Check if any DB record references this file
                if (!trackedPaths.has(relativePath)) {
                  // Record-less: only delete via the marker+grace gate. tmdbId
                  // parsed from the filename so the sink's JSON cross-check bites.
                  const tmdbMatch = file.match(/\{tmdb-(\d+)\}/);
                  const expectedTmdbId = tmdbMatch
                    ? parseInt(tmdbMatch[1], 10)
                    : undefined;
                  try {
                    const outcome = await sweepRecordlessPlaceholder(
                      filePath,
                      relativePath,
                      libraryInfo.libraryKey,
                      'movie',
                      expectedTmdbId
                    );
                    if (outcome === 'deleted') {
                      filesRemoved++;
                      deletedPaths.push({
                        fullPath: filePath,
                        relativePath,
                        libraryKey: libraryInfo.libraryKey,
                        mediaType: 'movie',
                      });
                      logger.info('Removed orphaned placeholder file', {
                        label: 'PlaceholderService',
                        path: relativePath,
                        mediaType: 'movie',
                        libraryKey: libraryInfo.libraryKey,
                      });
                    } else if (outcome === 'unproven') {
                      skippedUnproven++;
                      if (unprovenSamples.length < 5) {
                        unprovenSamples.push(relativePath);
                      }
                    }
                  } catch (error) {
                    logger.warn('Failed to remove orphaned placeholder file', {
                      label: 'PlaceholderService',
                      path: relativePath,
                      error:
                        error instanceof Error ? error.message : String(error),
                    });
                  }
                }
              }
            } catch (error) {
              // Folder access error, skip
              continue;
            }
          }
        } else if (libraryInfo.type === 'tv') {
          // Phase 1: Scan and collect orphaned TV paths
          const orphanedTvFiles: {
            filePath: string;
            relativePath: string;
          }[] = [];

          const showFolders = await fs.readdir(libraryInfo.path);

          for (const showFolder of showFolders) {
            const showPath = path.join(libraryInfo.path, showFolder);

            try {
              const stats = await fs.stat(showPath);
              if (!stats.isDirectory()) continue;

              const seasonFolders = await fs.readdir(showPath);
              for (const seasonFolder of seasonFolders) {
                if (seasonFolder !== 'Season 00') continue;

                const seasonPath = path.join(showPath, seasonFolder);
                const seasonStats = await fs.stat(seasonPath);
                if (!seasonStats.isDirectory()) continue;

                const files = await fs.readdir(seasonPath);
                for (const file of files) {
                  if (file !== 'S00E00.Trailer.mp4') continue;

                  const filePath = path.join(seasonPath, file);
                  const relativePath = path.join(
                    showFolder,
                    seasonFolder,
                    file
                  );

                  if (!trackedPaths.has(relativePath)) {
                    orphanedTvFiles.push({ filePath, relativePath });
                  }
                }
              }
            } catch (error) {
              continue;
            }
          }

          // Phase 2: Pre-resolve episode ratingKeys while files still exist
          const resolvedRatingKeys = new Map<string, string>();
          if (plexClient && orphanedTvFiles.length > 0) {
            try {
              const tvPaths = new Set(orphanedTvFiles.map((f) => f.filePath));
              const pathToKeys = await plexClient.findItemsByFilePaths(
                libraryInfo.libraryKey,
                tvPaths,
                4 // type=4 for episodes
              );
              for (const [filePath, keys] of pathToKeys) {
                if (keys.length > 0) {
                  resolvedRatingKeys.set(filePath, keys[0]);
                }
              }
              if (resolvedRatingKeys.size > 0) {
                logger.debug(
                  'Pre-resolved Plex episode ratingKeys for orphaned TV placeholders',
                  {
                    label: 'PlaceholderService',
                    resolved: resolvedRatingKeys.size,
                    total: orphanedTvFiles.length,
                  }
                );
              }
            } catch (error) {
              logger.warn('Failed to pre-resolve TV episode ratingKeys', {
                label: 'PlaceholderService',
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }

          // Phase 3: Delete files (marker+grace gated) and include resolved
          // ratingKeys in the result. TV omits expectedTmdbId (no filename tmdb
          // token); the sink still requires the .comingsoon marker.
          for (const { filePath, relativePath } of orphanedTvFiles) {
            try {
              const outcome = await sweepRecordlessPlaceholder(
                filePath,
                relativePath,
                libraryInfo.libraryKey,
                'tv',
                undefined
              );
              if (outcome === 'deleted') {
                filesRemoved++;
                deletedPaths.push({
                  fullPath: filePath,
                  relativePath,
                  libraryKey: libraryInfo.libraryKey,
                  mediaType: 'tv',
                  plexRatingKey: resolvedRatingKeys.get(filePath),
                });
                logger.info('Removed orphaned placeholder file', {
                  label: 'PlaceholderService',
                  path: relativePath,
                  mediaType: 'tv',
                  libraryKey: libraryInfo.libraryKey,
                });
              } else if (outcome === 'unproven') {
                skippedUnproven++;
                if (unprovenSamples.length < 5) {
                  unprovenSamples.push(relativePath);
                }
              }
            } catch (error) {
              logger.warn('Failed to remove orphaned placeholder file', {
                label: 'PlaceholderService',
                path: relativePath,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      } catch (error) {
        logger.warn('Failed to scan library for orphaned files', {
          label: 'PlaceholderService',
          path: libraryInfo.path,
          libraryKey: libraryInfo.libraryKey,
          mediaType: libraryInfo.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Aggregate skip log: one line per library instead of per-file spam.
      if (skippedUnproven > 0) {
        logger.warn(
          `Skipped ${skippedUnproven} unproven placeholder-like files (no Agregarr ownership marker) - not deleting; remove manually if unwanted`,
          {
            label: 'PlaceholderService',
            libraryKey: libraryInfo.libraryKey,
            count: skippedUnproven,
            samplePaths: unprovenSamples,
          }
        );
      }
    }

    if (filesRemoved > 0) {
      logger.info('Orphaned placeholder files cleaned up', {
        label: 'PlaceholderService',
        filesRemoved,
        deletedPaths: deletedPaths.map((p) => p.relativePath),
      });
    }

    return { filesRemoved, deletedPaths };
  } catch (error) {
    logger.error('Failed to cleanup orphaned placeholder files', {
      label: 'PlaceholderService',
      error: error instanceof Error ? error.message : String(error),
    });
    return { filesRemoved: 0, deletedPaths: [] };
  }
}

/**
 * Delete the stale Plex episode entry for a TV placeholder.
 * Navigates show → Season 00 → Episode 0 and deletes the episode.
 * Non-fatal: logs warnings on failure.
 */
async function deletePlexPlaceholderEpisode(
  plexClient: PlexAPI,
  showRatingKey: string,
  title: string
): Promise<void> {
  try {
    try {
      await plexClient.removeLabelFromItem(
        showRatingKey,
        'trailer-placeholder'
      );
    } catch {
      // Best-effort — don't block episode deletion
    }

    const seasons = await plexClient.getChildrenMetadata(showRatingKey);
    const season00 = seasons.find((s) => s.index === 0);
    if (!season00) return;

    const episodes = await plexClient.getChildrenMetadata(season00.ratingKey);
    const placeholderEp = episodes.find((ep) => ep.index === 0);
    if (!placeholderEp) return;

    // Route through the Sink-2 gate: if another config still shares this
    // placeholder (its S00E00.Trailer.mp4 is still on disk), the gate refuses
    // and the shared Plex entry is preserved.
    const deleted = await safeDeletePlaceholderPlexItem(
      plexClient,
      placeholderEp.ratingKey,
      'placeholder episode cleanup'
    );
    if (deleted) {
      logger.info('Deleted stale Plex placeholder episode', {
        label: 'PlaceholderCleanup',
        title,
        showRatingKey,
        episodeRatingKey: placeholderEp.ratingKey,
      });
    } else {
      logger.debug(
        'Kept Plex placeholder episode — gate refused (file present or shared)',
        {
          label: 'PlaceholderCleanup',
          title,
          showRatingKey,
          episodeRatingKey: placeholderEp.ratingKey,
        }
      );
    }
  } catch (error) {
    logger.warn('Failed to delete Plex placeholder episode', {
      label: 'PlaceholderCleanup',
      title,
      showRatingKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Check if any retroactively-applicable placeholder filters are configured.
 * Rating filters are excluded because retroactive evaluation uses
 * skipRatingFilters (unreleased content has no ratings).
 */
function hasPlaceholderFilters(config: CollectionConfig): boolean {
  if (config.placeholderMinimumYear && config.placeholderMinimumYear > 0)
    return true;

  const pfs = config.placeholderFilterSettings;
  if (pfs?.genres?.values?.length) return true;
  if (pfs?.countries?.values?.length) return true;
  if (pfs?.languages?.values?.length) return true;
  if (pfs?.keywords?.values?.length) return true;

  return false;
}

/**
 * Clean up placeholders for a collection:
 * 1. Items with real content detected in Plex (via discovery system)
 * 2. Items no longer in source data (orphaned items)
 * 3. Active items with missing placeholder files (self-healing — clears DB record for re-creation)
 *
 * Released items are tracked for configured window (placeholderReleasedDays, default: 7 days),
 * then database records are removed and overlay system automatically updates posters.
 *
 * Works for ANY collection type that creates placeholders.
 *
 * @param config - Collection configuration
 * @param plexClient - Plex API client
 * @param libraryCache - Optional cached library items for verification
 * @param sourceTmdbIds - Optional set of tmdbIds from current source for orphan detection
 */
export async function cleanupPlaceholdersForConfig(
  config: CollectionConfig,
  plexClient: PlexAPI,
  libraryCache?: LibraryItemsCache,
  sourceTmdbIds?: Set<number>
): Promise<void> {
  let repository;
  let placeholders;

  try {
    repository = getRepository(ComingSoonItem);
    // Find placeholders for this config (including multi-source sub-configs)
    placeholders = await repository.find({
      where: [
        { configId: config.id },
        { configId: Like(`${config.id}-source-%`) }, // Multi-source sub-collections
      ],
    });
  } catch (error) {
    // If table doesn't exist yet (first run), skip cleanup
    logger.debug('Skipping placeholder cleanup - table not initialized yet', {
      label: 'PlaceholderService',
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (placeholders.length === 0) {
    return;
  }

  logger.info('Checking placeholders for cleanup', {
    label: 'PlaceholderService',
    configName: config.name,
    count: placeholders.length,
  });

  // Mount-blip protection (§7): if the placeholder root for a media type is
  // unreadable OR reads empty while DB records for it exist, an empty readdir +
  // per-file ENOENT would drive the self-heal/orphan branches to mass-purge
  // records (then the next sync mass-recreates and re-downloads every
  // placeholder). Defer ALL record-driven file cleanup for that media type for
  // one sync instead. The global sweep needs no equivalent: an empty readdir
  // there yields zero candidates, zero deletes.
  const unsafeMediaTypes = new Set<'movie' | 'tv'>();
  for (const mediaType of new Set(placeholders.map((p) => p.mediaType))) {
    // Use the SAME array-aware resolver the deletion paths use (rootOf), not
    // getPlaceholderRootFolder(config.libraryId): a legacy array libraryId
    // stringifies to a bogus key there and returns undefined, which would
    // silently disengage this guard for exactly the config shape rootOf exists
    // to support.
    const root = rootOf(config.id, mediaType);
    if (!root) continue; // per-branch !libraryPath handling already covers this
    try {
      const entries = await fs.readdir(root);
      if (entries.length === 0) unsafeMediaTypes.add(mediaType);
    } catch {
      unsafeMediaTypes.add(mediaType); // unreachable root
    }
  }
  if (unsafeMediaTypes.size > 0) {
    logger.warn(
      'Placeholder root unavailable or empty while DB records exist - deferring file-level placeholder cleanup this sync (mount blip protection)',
      {
        label: 'PlaceholderService',
        configName: config.name,
        mediaTypes: [...unsafeMediaTypes],
      }
    );
  }

  let removedCount = 0;

  // NOTE: Title fixing and real content cleanup now happens globally during discovery
  // This function only handles collection-specific orphaned item cleanup

  // Fixed grace period for orphaned items - items that fall off the source list
  // are removed after this many days. One grace concept shared with the global
  // sweep (PLACEHOLDER_ORPHAN_GRACE_DAYS).
  const ORPHANED_GRACE_PERIOD_DAYS = PLACEHOLDER_ORPHAN_GRACE_DAYS;

  // Retroactive filter evaluation: check existing placeholders against current filters.
  // Placeholders that no longer pass filters are removed so filter changes take effect
  // on already-created placeholders, not just new ones.
  let filterPassedTmdbIds: Set<number> | undefined;

  if (
    config.createPlaceholdersForMissing &&
    hasPlaceholderFilters(config) &&
    sourceTmdbIds &&
    sourceTmdbIds.size > 0
  ) {
    // Collect non-orphaned placeholders for filter evaluation
    const nonOrphanedPlaceholders = placeholders.filter((p) =>
      sourceTmdbIds.has(p.tmdbId)
    );

    if (nonOrphanedPlaceholders.length > 0) {
      // Convert PlaceholderItem[] to MissingItem[] for the filter service
      const syntheticMissingItems: MissingItem[] = nonOrphanedPlaceholders.map(
        (p) => ({
          tmdbId: p.tmdbId,
          tvdbId: p.tvdbId,
          mediaType: p.mediaType,
          title: p.title,
          year: p.year,
          originalPosition: 0,
          source: p.source,
        })
      );

      try {
        const { missingItemFilterService, buildPlaceholderFilterConfig } =
          await import(
            '@server/lib/collections/services/MissingItemFilterService'
          );
        const placeholderFilterConfig = buildPlaceholderFilterConfig(config);
        const { filteredItems } =
          await missingItemFilterService.filterMissingItems(
            syntheticMissingItems,
            placeholderFilterConfig,
            'Placeholder Retroactive Filter',
            { skipMediaTypeCheck: true, skipRatingFilters: true }
          );

        filterPassedTmdbIds = new Set(filteredItems.map((item) => item.tmdbId));

        const filteredOutCount =
          nonOrphanedPlaceholders.length - filterPassedTmdbIds.size;
        if (filteredOutCount > 0) {
          logger.info(
            `${filteredOutCount} existing placeholders no longer match filters`,
            {
              label: 'PlaceholderService',
              configName: config.name,
              evaluated: nonOrphanedPlaceholders.length,
              passed: filterPassedTmdbIds.size,
              filteredOut: filteredOutCount,
            }
          );
        }
      } catch (filterError) {
        // Filter evaluation failure should not block other cleanup
        logger.warn('Failed to evaluate retroactive placeholder filters', {
          label: 'PlaceholderService',
          configName: config.name,
          error:
            filterError instanceof Error
              ? filterError.message
              : String(filterError),
        });
      }
    }
  }

  // Check for orphaned items (no longer in source)
  if (sourceTmdbIds && sourceTmdbIds.size > 0) {
    let orphanedCount = 0;

    for (const placeholder of placeholders) {
      try {
        // Mount-blip protection: defer all record-driven file cleanup for a
        // media type whose placeholder root is unreadable/empty this sync (§7).
        if (unsafeMediaTypes.has(placeholder.mediaType)) {
          continue;
        }

        const isOrphaned = !sourceTmdbIds.has(placeholder.tmdbId);

        // Self-healing: if item is still in source but placeholder file is
        // missing (external deletion, disk issue), remove the DB record so the
        // creation flow can recreate it next sync.
        if (!isOrphaned && placeholder.placeholderPath) {
          const { resolveRecordPath } = await import(
            '@server/lib/placeholders/placeholderManager'
          );
          // C4: resolve from the record's OWN config root, handling legacy
          // absolute rows (no double-join). An absolute row would otherwise
          // ENOENT here and wrongly purge the record, stranding the real file.
          const root = rootOf(placeholder.configId, placeholder.mediaType);

          if (root) {
            const fullPath = resolveRecordPath(
              root,
              placeholder.placeholderPath
            );
            try {
              await fs.access(fullPath);
            } catch (fileError) {
              // Only treat ENOENT (file not found) as genuinely missing.
              // Permission errors, NFS timeouts, etc. should not trigger cleanup.
              const isFileNotFound =
                fileError instanceof Error &&
                'code' in fileError &&
                (fileError as NodeJS.ErrnoException).code === 'ENOENT';

              if (isFileNotFound) {
                logger.info(
                  'Placeholder file missing for active item — removing DB record for re-creation',
                  {
                    label: 'PlaceholderService',
                    title: placeholder.title,
                    tmdbId: placeholder.tmdbId,
                    path: fullPath,
                  }
                );

                if (
                  placeholder.mediaType === 'tv' &&
                  placeholder.plexRatingKey
                ) {
                  await deletePlexPlaceholderEpisode(
                    plexClient,
                    placeholder.plexRatingKey,
                    placeholder.title
                  );
                }

                await repository.remove(placeholder);

                // Clean up empty parent directories left behind.
                // Placeholder metadata files (.comingsoon, .plexmatch) don't
                // count as content — remove them so the dirs qualify as empty.
                await cleanupPlaceholderRemnants(
                  fullPath,
                  placeholder.mediaType
                );

                removedCount++;
                continue; // Already removed — skip filter and orphan checks
              }
            }
          }
        }

        // Retroactive filter check: remove non-orphaned placeholders that
        // no longer pass the current placeholder filter configuration.
        if (
          !isOrphaned &&
          filterPassedTmdbIds &&
          !filterPassedTmdbIds.has(placeholder.tmdbId)
        ) {
          logger.info('Removing placeholder that fails current filters', {
            label: 'PlaceholderService',
            title: placeholder.title,
            tmdbId: placeholder.tmdbId,
          });

          // Use the same removal pattern as orphan cleanup:
          // file + Plex entry + DB record, all as a unit.
          // handledForThisConfig drives DB-record removal (this config no
          // longer wants the placeholder); fileActuallyDeleted gates the Plex
          // episode deletion (C3), so a kept shared file keeps its Plex entry.
          let handledForThisConfig = false;
          let fileActuallyDeleted = false;
          if (placeholder.placeholderPath) {
            const { removePlaceholder, resolveRecordPath } = await import(
              '@server/lib/placeholders/placeholderManager'
            );
            const root = rootOf(placeholder.configId, placeholder.mediaType);

            if (!root) {
              logger.error(
                'Library path not configured - cannot remove filtered placeholder',
                {
                  label: 'PlaceholderService',
                  title: placeholder.title,
                  mediaType: placeholder.mediaType,
                  libraryId: config.libraryId,
                }
              );
              continue;
            }

            const fullPath = resolveRecordPath(
              root,
              placeholder.placeholderPath
            );

            // Check if any OTHER collection still needs this file
            // Exclude both this config and its multi-source sub-configs
            const allRecordsForPath = await repository.find({
              where: {
                placeholderPath: placeholder.placeholderPath,
                configId: Not(config.id),
              },
            });
            const otherCollectionRecords = allRecordsForPath.filter(
              (r) => !r.configId.startsWith(`${config.id}-source-`)
            );

            if (otherCollectionRecords.length > 0) {
              handledForThisConfig = true;
              logger.info(
                'Filtered placeholder file shared with other collections - keeping file',
                {
                  label: 'PlaceholderService',
                  title: placeholder.title,
                  otherCollections: otherCollectionRecords.length,
                }
              );
            } else {
              try {
                await removePlaceholder(fullPath, placeholder.mediaType, {
                  source: 'db-record',
                  record: placeholder,
                  recordAbsPath: fullPath,
                });
                handledForThisConfig = true;
                fileActuallyDeleted = true;
              } catch (error) {
                const code =
                  error instanceof Error && 'code' in error
                    ? (error as NodeJS.ErrnoException).code
                    : undefined;

                if (code === 'ENOENT') {
                  // File already gone — clean up the leftover marker and
                  // empty directories so discovery doesn't re-detect it
                  await cleanupPlaceholderRemnants(
                    fullPath,
                    placeholder.mediaType
                  );
                  handledForThisConfig = true;
                  fileActuallyDeleted = true;
                } else {
                  // EOWNERSHIP or other: keep the DB record (fail-safe).
                  logger.error(
                    'Failed to remove filtered placeholder file - keeping database record',
                    {
                      label: 'PlaceholderService',
                      title: placeholder.title,
                      path: fullPath,
                      error:
                        error instanceof Error ? error.message : String(error),
                    }
                  );
                  continue;
                }
              }
            }
          } else {
            handledForThisConfig = true;
          }

          if (handledForThisConfig) {
            if (
              fileActuallyDeleted &&
              placeholder.mediaType === 'tv' &&
              placeholder.plexRatingKey
            ) {
              await deletePlexPlaceholderEpisode(
                plexClient,
                placeholder.plexRatingKey,
                placeholder.title
              );
            }

            await repository.remove(placeholder);
            removedCount++;
          }

          continue; // Skip orphan check - already handled
        }

        // For orphaned items, check if past configured window
        if (isOrphaned) {
          // This handles items that fall off source lists (e.g., Trakt Trending)
          // Keep them for placeholderReleasedDays from:
          // - Release date (if released) - so users see "recently released" items
          // - Creation date (if not released yet) - so users see upcoming items

          // Fetch release date from TMDB to determine window start
          const { placeholderContextService } = await import(
            '@server/lib/placeholders/services/PlaceholderContextService'
          );
          let context: { releaseDate?: string } = {};
          try {
            context = await placeholderContextService.getPlaceholderContext(
              placeholder
            );
          } catch (contextError) {
            logger.warn(
              'Failed to fetch context for orphaned placeholder, using creation date',
              {
                label: 'PlaceholderService',
                title: placeholder.title,
                tmdbId: placeholder.tmdbId,
                error:
                  contextError instanceof Error
                    ? contextError.message
                    : String(contextError),
              }
            );
          }

          let windowStartDate: Date = placeholder.createdAt;
          let windowType = 'creation';

          if (context.releaseDate) {
            // Check if release date is in the past (item has been released)
            const { isDateInFuture } = await import(
              '@server/utils/dateHelpers'
            );

            if (!isDateInFuture(context.releaseDate)) {
              // Item has been released - use release date as window start
              // Parse ISO date string (YYYY-MM-DD) as UTC midnight
              const dateOnly = context.releaseDate.split('T')[0];
              windowStartDate = new Date(dateOnly + 'T00:00:00.000Z');
              windowType = 'release';
            }
          }

          const daysSinceWindowStart = Math.floor(
            (Date.now() - windowStartDate.getTime()) / (24 * 60 * 60 * 1000)
          );

          if (daysSinceWindowStart > ORPHANED_GRACE_PERIOD_DAYS) {
            const reason = `orphaned (${daysSinceWindowStart} days since ${windowType}, window: ${ORPHANED_GRACE_PERIOD_DAYS} days)`;

            logger.info('Removing orphaned placeholder past window', {
              label: 'PlaceholderService',
              title: placeholder.title,
              source: placeholder.source,
              reason,
              windowType,
              daysSinceWindowStart,
              ORPHANED_GRACE_PERIOD_DAYS,
              releaseDate: context.releaseDate,
            });

            // Remove placeholder file if it exists. handledForThisConfig drives
            // DB-record removal; fileActuallyDeleted gates the Plex episode
            // deletion (C3) so a kept shared file keeps its Plex entry.
            let handledForThisConfig = false;
            let fileActuallyDeleted = false;
            if (placeholder.placeholderPath) {
              const { removePlaceholder, resolveRecordPath } = await import(
                '@server/lib/placeholders/placeholderManager'
              );
              const root = rootOf(placeholder.configId, placeholder.mediaType);

              if (!root) {
                logger.error(
                  'Library path not configured - cannot remove placeholder file',
                  {
                    label: 'PlaceholderService',
                    title: placeholder.title,
                    mediaType: placeholder.mediaType,
                    libraryId: config.libraryId,
                  }
                );
                continue;
              }

              // C4: resolve from the record's own config root (legacy-absolute safe)
              const fullPath = resolveRecordPath(
                root,
                placeholder.placeholderPath
              );

              // Check if any OTHER collection still needs this file
              const otherCollectionRecords = await repository.find({
                where: {
                  placeholderPath: placeholder.placeholderPath,
                  configId: Not(config.id),
                },
              });

              if (otherCollectionRecords.length > 0) {
                // Other collections still use this file - don't delete it
                handledForThisConfig = true;
                logger.info(
                  'Placeholder file past window shared with other collections - keeping file',
                  {
                    label: 'PlaceholderService',
                    title: placeholder.title,
                    otherCollections: otherCollectionRecords.length,
                  }
                );
              } else {
                // No other collections use this file - safe to delete
                try {
                  await removePlaceholder(fullPath, placeholder.mediaType, {
                    source: 'db-record',
                    record: placeholder,
                    recordAbsPath: fullPath,
                  });
                  handledForThisConfig = true;
                  fileActuallyDeleted = true;
                  logger.info('Removed placeholder file', {
                    label: 'PlaceholderService',
                    title: placeholder.title,
                    path: fullPath,
                  });
                } catch (error) {
                  // If file doesn't exist (ENOENT), treat as successful removal
                  const code =
                    error instanceof Error && 'code' in error
                      ? (error as NodeJS.ErrnoException).code
                      : undefined;

                  if (code === 'ENOENT') {
                    // File already gone — clean up the leftover marker and
                    // empty directories so discovery doesn't re-detect it
                    await cleanupPlaceholderRemnants(
                      fullPath,
                      placeholder.mediaType
                    );
                    handledForThisConfig = true;
                    fileActuallyDeleted = true;
                    logger.info(
                      'Placeholder file already removed - cleaning up database record',
                      {
                        label: 'PlaceholderService',
                        title: placeholder.title,
                        path: fullPath,
                      }
                    );
                  } else {
                    // EOWNERSHIP or other: keep the DB record (fail-safe).
                    logger.error(
                      'Failed to remove placeholder file - keeping database record',
                      {
                        label: 'PlaceholderService',
                        title: placeholder.title,
                        path: fullPath,
                        error:
                          error instanceof Error
                            ? error.message
                            : String(error),
                      }
                    );
                    continue;
                  }
                }
              }
            } else {
              handledForThisConfig = true; // No file to remove
            }

            // Remove from database if handled for this config
            if (handledForThisConfig) {
              // Delete the stale Plex episode entry only when we actually
              // removed the on-disk file (C3).
              if (
                fileActuallyDeleted &&
                placeholder.mediaType === 'tv' &&
                placeholder.plexRatingKey
              ) {
                await deletePlexPlaceholderEpisode(
                  plexClient,
                  placeholder.plexRatingKey,
                  placeholder.title
                );
              }

              await repository.remove(placeholder);
              removedCount++;
              orphanedCount++;

              logger.info('Removed placeholder from database', {
                label: 'PlaceholderService',
                title: placeholder.title,
                source: placeholder.source,
                reason,
              });
            }
          }
        }
      } catch (error) {
        logger.error('Error processing placeholder cleanup', {
          label: 'PlaceholderService',
          title: placeholder.title,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (orphanedCount > 0) {
      logger.info('Orphaned placeholder cleanup summary', {
        label: 'PlaceholderService',
        configName: config.name,
        orphaned: orphanedCount,
      });
    }
  }

  if (removedCount > 0) {
    logger.info('Placeholder cleanup completed', {
      label: 'PlaceholderService',
      configName: config.name,
      removed: removedCount,
    });
  }
}

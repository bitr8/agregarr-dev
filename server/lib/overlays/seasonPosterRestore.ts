import type PlexAPI from '@server/api/plexapi';
import logger from '@server/logger';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

/**
 * Restore a season's original (pre-overlay) base poster to Plex, THROWING on
 * any failure of the critical restore path (missing backup, image processing,
 * or upload).
 *
 * Used by the Maintainerr season-overlay cleanup lifecycle: the caller deletes
 * the tracked metadata row + stored base poster ONLY when this resolves, so a
 * transient failure must throw to preserve recovery data for the next run.
 *
 * The stored base poster IS the recovery data, so it is read directly rather
 * than through getBasePosterForOverlay. That helper decides what counts as the
 * base by matching the live Plex poster against the row's recorded URLs, and
 * when neither matches it treats whatever Plex currently shows as the new base -
 * downloading it and overwriting the stored original. A row whose
 * `ourOverlayPosterUrl` has gone stale (the overlay upload succeeded but the
 * write recording it did not: see the swallowed catch around
 * `recordOverlayApplicationWithBasePoster` in OverlayLibraryService) lands in
 * exactly that branch, so the "restore" would re-upload our own countdown
 * poster, overwrite the real base with it, and report success - after which
 * cleanup deletes the row and the file. Reading the backup directly cannot
 * mistake an overlay for a base.
 *
 * What that costs: if a user manually replaced the season's poster in Plex
 * AFTER the overlay was applied, this reverts to the pre-overlay original
 * instead of keeping their replacement. Rare, and they can simply set it again.
 * Baking a countdown into the poster and destroying the only copy of the base
 * is neither rare enough nor reversible.
 *
 * A missing backup throws. The caller keeps the row and retries, which is the
 * one deliberate divergence from Maintainerr's revertItemInternal (which clears
 * state and stops tracking). The poster is stuck either way; only keeping the
 * row can still heal if the file comes back.
 *
 * Label removal is best-effort: the poster upload IS the recovery, so a failed
 * "Overlay" label removal is logged but does not block cleanup. Throwing on it
 * would re-run a full restore every cleanup pass for a cosmetic label - the
 * delete/recreate churn this codebase avoids elsewhere. The trade is that a
 * label whose removal fails is orphaned once the caller drops the row.
 */
export async function restoreSeasonBasePoster(
  plexApi: PlexAPI,
  libraryId: string,
  ratingKey: string,
  title: string
): Promise<void> {
  const { plexBasePosterManager } = await import(
    '@server/lib/overlays/PlexBasePosterManager'
  );

  const basePoster = await plexBasePosterManager.getStoredBasePoster(
    libraryId,
    ratingKey
  );

  if (!basePoster) {
    // getStoredBasePoster returns null for ANY read failure, not just ENOENT, so
    // an unreadable file (EACCES, EIO, unmounted share) is indistinguishable from
    // a missing one here. Both are "no recovery data right now", and both must
    // reach the caller as a throw so it keeps the row and retries.
    throw new Error(
      `No readable stored base poster for season ${ratingKey} - missing or unreadable, nothing to restore from`
    );
  }

  // Normalise to the format/size Plex expects for an uploaded poster.
  const posterBuffer = await sharp(basePoster)
    .resize(1000, 1500, { fit: 'cover', position: 'center' })
    .webp({ quality: 90 })
    .toBuffer();

  // randomUUID (not Date.now()) so two restores of the same season can never
  // collide on the temp path and unlink each other's in-flight upload.
  const tempFilePath = path.join(
    os.tmpdir(),
    `season-restore-${ratingKey}-${randomUUID()}.webp`
  );

  await fs.writeFile(tempFilePath, posterBuffer);

  try {
    // Critical: a failed upload must throw so the caller keeps the row + base
    // poster for the next run.
    await plexApi.uploadPosterFromFile(ratingKey, tempFilePath);

    // Best-effort: the poster is already restored; a lingering label is cosmetic.
    try {
      await plexApi.removeLabelFromItem(ratingKey, 'Overlay');
    } catch (labelError) {
      logger.warn(
        'Season poster restored but Overlay label removal failed - the label is now orphaned',
        {
          label: 'MaintainerrSeasonOverlay',
          ratingKey,
          error:
            labelError instanceof Error
              ? labelError.message
              : String(labelError),
        }
      );
    }

    logger.info('Restored season base poster', {
      label: 'MaintainerrSeasonOverlay',
      ratingKey,
      title,
    });
  } finally {
    await fs.unlink(tempFilePath).catch(() => {
      // Ignore temp cleanup errors.
    });
  }
}

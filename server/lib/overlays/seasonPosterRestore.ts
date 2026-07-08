import type PlexAPI from '@server/api/plexapi';
import type { PlexLibraryItem } from '@server/api/plexapi';
import type { MediaItemMetadata } from '@server/entity/MediaItemMetadata';
import logger from '@server/logger';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

/**
 * Restore a season's original (pre-overlay) base poster to Plex, THROWING on
 * any failure of the critical restore path (base-poster resolution, image
 * processing, or upload).
 *
 * Used by the Maintainerr season-overlay cleanup lifecycle: the caller deletes
 * the tracked metadata row + stored base poster ONLY when this resolves, so a
 * transient failure must throw to preserve recovery data for the next run.
 *
 * Mirrors the mechanics of PosterResetJob.resetItemPoster but deliberately
 * differs in three ways:
 *  - throws instead of swallowing (the reset job's per-item loop swallows so
 *    one bad item doesn't abort the batch; here failure must reach the caller),
 *  - never re-writes the metadata row (the caller owns row deletion on success),
 *  - forces posterSource 'plex' (seasons always track a Plex base poster).
 *
 * The no-backup case is handled for us by getBasePosterForOverlay('plex'): if
 * the stored base poster is gone AND Plex still shows our overlaid poster, it
 * throws ("Cannot use overlaid poster as base") rather than baking the
 * countdown in as the new base. That throw propagates here, and the caller
 * keeps the row to retry (or, per the cleanup policy, clears a confirmed
 * no-backup row without a restore attempt).
 *
 * Label removal is best-effort: the poster upload IS the recovery, so a failed
 * "Overlay" label removal is logged but does not block cleanup. Throwing on it
 * would re-run a full restore every cleanup pass for a cosmetic label - the
 * delete/recreate churn this codebase avoids elsewhere.
 */
export async function restoreSeasonBasePoster(
  plexApi: PlexAPI,
  item: PlexLibraryItem,
  libraryId: string,
  libraryName: string,
  metadata: MediaItemMetadata
): Promise<void> {
  const { plexBasePosterManager } = await import(
    '@server/lib/overlays/PlexBasePosterManager'
  );

  // Resolve the pre-overlay base poster. Forcing 'plex' matches how seasons are
  // overlaid; the 'plex' branch reads only item.ratingKey (no Media/Guid/tmdb),
  // so a season item (no Media, wrong-namespace Guid) is safe here.
  const basePosterResult = await plexBasePosterManager.getBasePosterForOverlay(
    plexApi,
    item,
    libraryId,
    libraryName,
    'show',
    'plex',
    {
      basePosterSource: metadata.basePosterSource,
      originalPlexPosterUrl: metadata.originalPlexPosterUrl,
      ourOverlayPosterUrl: metadata.ourOverlayPosterUrl,
      basePosterFilename: metadata.basePosterFilename,
      localPosterModifiedTime: metadata.localPosterModifiedTime,
    },
    undefined
  );

  // Normalise to the format/size Plex expects for an uploaded poster.
  const posterBuffer = await sharp(basePosterResult.posterBuffer)
    .resize(1000, 1500, { fit: 'cover', position: 'center' })
    .webp({ quality: 90 })
    .toBuffer();

  // randomUUID (not Date.now()) so two restores of the same season can never
  // collide on the temp path and unlink each other's in-flight upload.
  const tempFilePath = path.join(
    os.tmpdir(),
    `season-restore-${item.ratingKey}-${randomUUID()}.webp`
  );

  await fs.writeFile(tempFilePath, posterBuffer);

  try {
    // Critical: a failed upload must throw so the caller keeps the row + base
    // poster for the next run.
    await plexApi.uploadPosterFromFile(item.ratingKey, tempFilePath);

    // Best-effort: the poster is already restored; a lingering label is cosmetic.
    try {
      await plexApi.removeLabelFromItem(item.ratingKey, 'Overlay');
    } catch (labelError) {
      logger.warn('Season poster restored but Overlay label removal failed', {
        label: 'MaintainerrSeasonOverlay',
        ratingKey: item.ratingKey,
        error:
          labelError instanceof Error ? labelError.message : String(labelError),
      });
    }

    logger.info('Restored season base poster', {
      label: 'MaintainerrSeasonOverlay',
      ratingKey: item.ratingKey,
      title: item.title,
    });
  } finally {
    await fs.unlink(tempFilePath).catch(() => {
      // Ignore temp cleanup errors.
    });
  }
}

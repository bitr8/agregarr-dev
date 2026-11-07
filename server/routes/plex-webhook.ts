import PlexAPI from '@server/api/plexapi';
import PlexTvAPI from '@server/api/plextv';
import { getRepository } from '@server/datasource';
import { PlaceholderItem } from '@server/entity/PlaceholderItem';
import { getAdminUser } from '@server/lib/collections/core/CollectionUtilities';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import multer, { MulterError } from 'multer';

const router = Router();

// The thumb is never read, so discard file parts instead of buffering them: memory
// stays flat no matter the size or the concurrency. Text fields are bounded because
// busboy otherwise allows unlimited fields at 1MB each.
const upload = multer({
  fileFilter: (_req, _file, cb) => cb(null, false),
  limits: { fields: 4, parts: 6, fieldSize: 256 * 1024 },
});

let warnedAboutRejection = false;

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Runs before multer: an unauthenticated caller never gets a body buffered
function requireWebhookToken(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const expected = getSettings().main.plexWebhookToken;
  const provided = req.query.token;

  if (
    !expected ||
    typeof provided !== 'string' ||
    !secretMatches(provided, expected)
  ) {
    // Warn once, then drop to debug: this path is unauthenticated, so logging every
    // rejection at warn lets a stranger fill the disk. Once is enough to diagnose
    // an upgrade that left a stale URL in Plex.
    if (!warnedAboutRejection) {
      warnedAboutRejection = true;
      logger.warn(
        'Rejected Plex webhook: missing or invalid token. If you upgraded, re-copy the webhook URL from Settings > Downloads into Plex, it now carries a token. Further rejections log at debug.',
        { label: 'PlexWebhook', ip: req.ip }
      );
    } else {
      logger.debug('Rejected Plex webhook: missing or invalid token', {
        label: 'PlexWebhook',
        ip: req.ip,
      });
    }
    res.status(401).json({ error: 'Invalid webhook token' });
    return;
  }

  next();
}

interface PlexWebhookMetadata {
  ratingKey?: string;
  grandparentRatingKey?: string;
  type?: string;
  title?: string;
  editionTitle?: string;
}

interface PlexWebhookPayload {
  event: string;
  Account?: { id?: number };
  Metadata?: PlexWebhookMetadata;
}

function isPlaceholderMetadata(metadata: PlexWebhookMetadata): boolean {
  // Movie placeholders: editionTitle is set from the {edition-Trailer} filename token
  if (
    metadata.editionTitle &&
    metadata.editionTitle.toLowerCase().includes('trailer')
  ) {
    return true;
  }
  // TV placeholders: PlaceholderTitleFixer sets "Trailer (Placeholder)" after scan.
  // Before it runs, Plex reads the filename S00E00.Trailer.mp4 and titles it "Trailer".
  if (
    metadata.type === 'episode' &&
    (metadata.title === 'Trailer (Placeholder)' || metadata.title === 'Trailer')
  ) {
    return true;
  }
  return false;
}

async function getPlexClient(): Promise<{
  client: PlexAPI;
  adminToken: string;
  adminPlexId?: number;
} | null> {
  try {
    const adminUser = await getAdminUser();
    if (!adminUser?.plexToken) return null;
    const settings = getSettings();
    return {
      client: new PlexAPI({
        plexToken: adminUser.plexToken,
        plexSettings: settings.plex,
      }),
      adminToken: adminUser.plexToken,
      adminPlexId: adminUser.plexId,
    };
  } catch {
    return null;
  }
}

async function unscrobblePlaceholder(
  ratingKey: string,
  plexClient: PlexAPI,
  who: string,
  resetProgress: boolean
): Promise<void> {
  try {
    await plexClient.markItemAsUnplayed(ratingKey);
    logger.info('Unscrobbled placeholder item', {
      label: 'PlexWebhook',
      ratingKey,
      who,
    });
  } catch (error) {
    logger.error('Failed to unscrobble placeholder item', {
      label: 'PlexWebhook',
      ratingKey,
      who,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!resetProgress) return;
  try {
    await plexClient.resetItemProgress(ratingKey);
  } catch (error) {
    logger.warn('Failed to reset placeholder resume progress', {
      label: 'PlexWebhook',
      ratingKey,
      who,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function isConfirmedPlaceholder(
  ratingKey: string,
  plexClient: PlexAPI
): Promise<boolean> {
  try {
    const row = await getRepository(PlaceholderItem).findOne({
      where: { plexRatingKey: ratingKey },
    });
    if (row) return true;
    const metadata = await plexClient.getMetadata(ratingKey);
    return !!metadata?.Label?.some((l) => l.tag === 'trailer-placeholder');
  } catch {
    return false;
  }
}

async function unscrobbleAsSharedUser(
  ratingKey: string,
  accountId: number,
  adminToken: string,
  resetProgress: boolean
): Promise<void> {
  try {
    const settings = getSettings();
    if (!settings.plex.machineId) return;
    const userToken = await new PlexTvAPI(adminToken).getSharedUserToken(
      settings.plex.machineId,
      accountId
    );
    if (!userToken) return;
    await unscrobblePlaceholder(
      ratingKey,
      new PlexAPI({ plexToken: userToken, plexSettings: settings.plex }),
      'shared user',
      resetProgress
    );
  } catch (error) {
    logger.error('Failed to unscrobble placeholder as shared user', {
      label: 'PlexWebhook',
      ratingKey,
      accountId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// POST / — receives Plex webhook events (multipart/form-data)
router.post('/', requireWebhookToken, upload.any(), async (req, res) => {
  // Respond immediately — Plex doesn't wait for our processing
  res.sendStatus(200);

  // The response is already sent, so nothing below may throw: an async handler
  // that rejects after this point is an unhandled rejection, and node exits on those.
  try {
    const rawPayload = req.body?.payload as string | undefined;
    if (!rawPayload) {
      logger.warn('Received webhook with no payload', {
        label: 'PlexWebhook',
      });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      logger.warn('Failed to parse webhook payload JSON', {
        label: 'PlexWebhook',
      });
      return;
    }

    // JSON.parse('null') and JSON.parse('1') both parse fine and both break destructuring
    if (!payload || typeof payload !== 'object') {
      logger.warn('Webhook payload was not an object', {
        label: 'PlexWebhook',
      });
      return;
    }

    const {
      event,
      Metadata: metadata,
      Account: account,
    } = payload as PlexWebhookPayload;

    logger.info('Plex webhook received', {
      label: 'PlexWebhook',
      event,
      title: metadata?.title,
      type: metadata?.type,
      editionTitle: metadata?.editionTitle,
      ratingKey: metadata?.ratingKey,
    });

    // Act on play, stop, and scrobble events
    // media.scrobble is fired by Plex when an item is marked as watched (~90% completion)
    if (
      event !== 'media.play' &&
      event !== 'media.stop' &&
      event !== 'media.scrobble'
    )
      return;
    if (!metadata?.ratingKey) return;

    const ratingKey = String(metadata.ratingKey);
    // Interpolated into a Plex query string by markItemAsUnplayed, so '&' in a
    // caller-supplied value would inject parameters
    if (!/^\d+$/.test(ratingKey)) {
      logger.warn('Webhook payload had a non-numeric ratingKey', {
        label: 'PlexWebhook',
      });
      return;
    }

    if (!isPlaceholderMetadata(metadata)) return;

    logger.info('Placeholder detected — calling unscrobble', {
      label: 'PlexWebhook',
      event,
      ratingKey,
      title: metadata.title,
      editionTitle: metadata.editionTitle,
    });

    const admin = await getPlexClient();
    if (!admin) return;
    // TV placeholders are recorded and labelled on the show, not the episode
    const grandparentKey = String(metadata.grandparentRatingKey ?? '');
    const confirmKey =
      metadata.type === 'episode' && /^\d+$/.test(grandparentKey)
        ? grandparentKey
        : ratingKey;
    const confirmed = await isConfirmedPlaceholder(confirmKey, admin.client);
    const resetProgress = confirmed && event !== 'media.play';
    await unscrobblePlaceholder(
      ratingKey,
      admin.client,
      'admin',
      resetProgress
    );
    if (!confirmed) return;

    const accountId = Number(account?.id);
    // PMS reports the server owner as local account 1
    if (
      Number.isInteger(accountId) &&
      accountId > 1 &&
      accountId !== admin.adminPlexId
    ) {
      await unscrobbleAsSharedUser(
        ratingKey,
        accountId,
        admin.adminToken,
        resetProgress
      );
    }
  } catch (error) {
    logger.error('Webhook processing failed after responding', {
      label: 'PlexWebhook',
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

const LIMIT_CODES = new Set([
  'LIMIT_FILE_SIZE',
  'LIMIT_FILE_COUNT',
  'LIMIT_FIELD_COUNT',
  'LIMIT_FIELD_KEY',
  'LIMIT_FIELD_VALUE',
  'LIMIT_PART_COUNT',
]);

// Multer aborts mid-stream; answer explicitly so the socket closes rather than hanging
router.use(
  (err: Error, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (!(err instanceof MulterError)) {
      next(err);
      return;
    }

    const status = LIMIT_CODES.has(err.code) ? 413 : 400;
    logger.warn('Rejected webhook body', {
      label: 'PlexWebhook',
      code: err.code,
      status,
    });
    res.status(status).json({ error: err.code });
  }
);

export default router;

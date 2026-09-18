import collectionsSync from '@server/lib/collectionsSync';
import overlayApplication from '@server/lib/overlayApplication';
import posterizarrTriggerJob from '@server/lib/posterizarrTrigger';
import { getSettings } from '@server/lib/settings';
import { Router, type Response } from 'express';

const router = Router();

const integrationDisabledResponse = (res: Response) =>
  res.status(403).json({
    error: 'Posterizarr integration is disabled in Agregarr settings',
  });

router.post('/trigger', (req, res) => {
  if (!getSettings().overlays?.posterizarrIntegrationEnabled) {
    return integrationDisabledResponse(res);
  }

  if (
    collectionsSync.status.running ||
    collectionsSync.status.pending ||
    overlayApplication.status.running ||
    overlayApplication.status.pending
  ) {
    res.setHeader('Retry-After', '30');
    return res.status(409).json({
      error: 'A full collection or overlay sync is running',
      retryable: true,
    });
  }

  const { ratingKey, title, mediaType, seasonNumber, episodeNumber } =
    req.body ?? {};

  if (typeof ratingKey !== 'string' || !/^[1-9]\d*$/.test(ratingKey.trim())) {
    return res.status(400).json({
      error: 'ratingKey is required and must be a positive Plex rating key',
    });
  }
  if (title !== undefined && typeof title !== 'string') {
    return res.status(400).json({ error: 'title must be a string' });
  }
  if (
    mediaType !== undefined &&
    mediaType !== 'movie' &&
    mediaType !== 'show'
  ) {
    return res.status(400).json({ error: 'mediaType must be movie or show' });
  }
  if (
    seasonNumber !== undefined &&
    (!Number.isInteger(seasonNumber) || seasonNumber < 0)
  ) {
    return res
      .status(400)
      .json({ error: 'seasonNumber must be a non-negative integer' });
  }
  if (
    episodeNumber !== undefined &&
    (!Number.isInteger(episodeNumber) || episodeNumber < 1)
  ) {
    return res
      .status(400)
      .json({ error: 'episodeNumber must be a positive integer' });
  }
  if (episodeNumber !== undefined && seasonNumber === undefined) {
    return res
      .status(400)
      .json({ error: 'seasonNumber is required with episodeNumber' });
  }
  if (
    (seasonNumber !== undefined || episodeNumber !== undefined) &&
    mediaType !== 'show'
  ) {
    return res.status(400).json({
      error: 'seasonNumber and episodeNumber are only valid for show triggers',
    });
  }

  const normalizedRatingKey = ratingKey.trim();
  const result = posterizarrTriggerJob.enqueue({
    ratingKey: normalizedRatingKey,
    title,
    mediaType,
    seasonNumber,
    episodeNumber,
  });

  if (result.rejected) {
    res.setHeader('Retry-After', '15');
    return res.status(429).json({
      error: 'Posterizarr trigger queue is full',
      retryable: true,
      ...result,
    });
  }

  return res.status(202).json({
    message: result.deduplicated
      ? 'Posterizarr item trigger was already queued or recently completed'
      : 'Posterizarr item trigger queued',
    ratingKey: normalizedRatingKey,
    ...result,
  });
});

router.get('/status', (_req, res) => {
  if (!getSettings().overlays?.posterizarrIntegrationEnabled) {
    return integrationDisabledResponse(res);
  }

  return res.status(200).json(posterizarrTriggerJob.status);
});

export default router;

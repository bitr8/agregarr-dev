import PlexAPI from '@server/api/plexapi';
import type {
  GroupInput,
  OwnSettingsPatch,
  RotateResult,
  Visibility,
} from '@server/interfaces/api/rotationInterfaces';
import { getAdminUser } from '@server/lib/collections/core/CollectionUtilities';
import collectionsSync from '@server/lib/collectionsSync';
import { rotationApply } from '@server/lib/rotation/rotationApply';
import {
  rotationGroupService as service,
  RotationNotFoundError,
  RotationValidationError,
} from '@server/lib/rotation/RotationGroupService';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import axios from 'axios';
import type { Response } from 'express';
import { Router } from 'express';

const LABEL = 'Rotation Groups API';
const INTERVALS = ['every_sync', '12h', 'daily', 'weekly', 'monthly_random'];
const ORDERS = ['sequential', 'shuffled'];
const KINDS = ['collection', 'preExisting'];
const VISIBILITY_KEYS = ['usersHome', 'serverOwnerHome', 'libraryRecommended'];

const rotationGroupsRoutes = Router();

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isVisibility = (v: unknown): boolean =>
  isObject(v) && VISIBILITY_KEYS.every((k) => typeof v[k] === 'boolean');

function syncBusy(): boolean {
  const s = collectionsSync.status;
  return s.running || s.pending || rotationApply.status.running;
}

function rejectIfBusy(res: Response): boolean {
  if (!syncBusy()) return false;
  res.status(409).json({
    code: 'SYNC_RUNNING',
    message:
      'A sync is running. Try again when it has finished, or wait for the next one.',
  });
  return true;
}

function fail(res: Response, error: unknown, what: string): void {
  if (error instanceof RotationValidationError) {
    res.status(400).json({ message: error.message });
    return;
  }
  if (error instanceof RotationNotFoundError) {
    res.status(404).json({ message: error.message });
    return;
  }
  logger.error(`Failed to ${what}`, {
    label: LABEL,
    error: error instanceof Error ? error.message : String(error),
  });
  res.status(500).json({
    error: `Failed to ${what}`,
    message: error instanceof Error ? error.message : 'Unknown error',
  });
}

function validateGroupInput(body: unknown): string | null {
  if (!isObject(body)) return 'Body must be an object';
  const { name, libraryId, enabled, slotCount, interval, weekday, order } =
    body;
  if (typeof name !== 'string' || !name.trim() || name.length > 60) {
    return 'name must be 1 to 60 characters';
  }
  if (typeof libraryId !== 'string' || !libraryId) {
    return 'libraryId is required';
  }
  if (typeof enabled !== 'boolean') return 'enabled must be a boolean';
  if (!Number.isInteger(slotCount) || (slotCount as number) < 1) {
    return 'slotCount must be an integer from 1 to 20';
  }
  if ((slotCount as number) > 20) return 'slotCount must be at most 20';
  if (typeof interval !== 'string' || !INTERVALS.includes(interval)) {
    return `interval must be one of ${INTERVALS.join(', ')}`;
  }
  if (interval === 'weekly' && weekday === undefined) {
    return 'weekday is required for a weekly interval';
  }
  if (
    weekday !== undefined &&
    (!Number.isInteger(weekday) ||
      (weekday as number) < 0 ||
      (weekday as number) > 6)
  ) {
    return 'weekday must be an integer from 0 to 6';
  }
  if (typeof order !== 'string' || !ORDERS.includes(order)) {
    return `order must be one of ${ORDERS.join(', ')}`;
  }
  if (!isVisibility(body.surfaces)) {
    return 'surfaces must have usersHome, serverOwnerHome and libraryRecommended booleans';
  }
  const s = body.surfaces as Record<string, boolean>;
  if (!VISIBILITY_KEYS.some((k) => s[k])) {
    return 'At least one surface must be on';
  }
  if (!Array.isArray(body.members)) return 'members must be an array';
  if (body.members.length > 500) return 'A group can have at most 500 members';
  for (const m of body.members) {
    if (
      !isObject(m) ||
      typeof m.kind !== 'string' ||
      !KINDS.includes(m.kind) ||
      typeof m.configId !== 'string' ||
      !m.configId
    ) {
      return 'Each member needs a kind and a configId';
    }
  }
  return null;
}

function validatePreviewInput(body: unknown): string | null {
  const err = validateGroupInput(body);
  if (err) return err;
  const id = (body as Record<string, unknown>).id;
  if (id !== undefined && typeof id !== 'string') return 'id must be a string';
  return null;
}

function toGroupInput(body: Record<string, unknown>): GroupInput {
  const input = body as unknown as GroupInput;
  const dto: GroupInput = {
    name: input.name,
    libraryId: input.libraryId,
    enabled: input.enabled,
    slotCount: input.slotCount,
    interval: input.interval,
    order: input.order,
    surfaces: {
      usersHome: input.surfaces.usersHome,
      serverOwnerHome: input.surfaces.serverOwnerHome,
      libraryRecommended: input.surfaces.libraryRecommended,
    },
    members: input.members.map((m) => ({
      kind: m.kind,
      configId: m.configId,
    })),
  };
  if (input.weekday !== undefined) dto.weekday = input.weekday;
  return dto;
}

function toVisibility(v: unknown): Visibility {
  const o = v as Visibility;
  return {
    usersHome: o.usersHome,
    serverOwnerHome: o.serverOwnerHome,
    libraryRecommended: o.libraryRecommended,
  };
}

function toPatch(body: Record<string, unknown>): OwnSettingsPatch {
  const patch: OwnSettingsPatch = {};
  if (body.visibilityConfig !== undefined) {
    patch.visibilityConfig = toVisibility(body.visibilityConfig);
  }
  if (body.inactiveVisibilityConfig !== undefined) {
    patch.inactiveVisibilityConfig = toVisibility(
      body.inactiveVisibilityConfig
    );
  }
  if (body.randomizeHomeOrder !== undefined) {
    patch.randomizeHomeOrder = body.randomizeHomeOrder as boolean;
  }
  return patch;
}

function plexOrigin(): string {
  const { plex } = getSettings();
  return new URL(`${plex.useSsl ? 'https' : 'http'}://${plex.ip}:${plex.port}`)
    .origin;
}

const POSTER_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const POSTER_MAX_BYTES = 10 * 1024 * 1024;

function isTrustedPosterUrl(url: string): boolean {
  if (url.startsWith('/')) return true;
  try {
    return new URL(url).origin === plexOrigin();
  } catch {
    return false;
  }
}

async function getPlexClient(): Promise<PlexAPI> {
  const admin = await getAdminUser();
  if (!admin?.plexToken) throw new Error('No admin Plex token found');
  return new PlexAPI({
    plexToken: admin.plexToken,
    plexSettings: getSettings().plex,
    timeout: 30000,
  });
}

rotationGroupsRoutes.get('/', async (_req, res) => {
  try {
    res.status(200).json({ groups: await service.listStatus() });
  } catch (error) {
    fail(res, error, 'list rotation groups');
  }
});

rotationGroupsRoutes.post('/preview', async (req, res) => {
  const message = validatePreviewInput(req.body);
  if (message) return res.status(400).json({ message });
  try {
    return res.status(200).json(
      await service.previewDraft({
        ...toGroupInput(req.body),
        ...(typeof req.body.id === 'string' ? { id: req.body.id } : {}),
      })
    );
  } catch (error) {
    return fail(res, error, 'preview rotation group');
  }
});

rotationGroupsRoutes.get('/candidates', async (req, res) => {
  const { libraryId } = req.query;
  if (libraryId !== undefined && typeof libraryId !== 'string') {
    return res.status(400).json({ message: 'libraryId must be a string' });
  }
  try {
    return res
      .status(200)
      .json({ items: await service.listCandidates(libraryId || undefined) });
  } catch (error) {
    return fail(res, error, 'list rotation candidates');
  }
});

rotationGroupsRoutes.get('/membership', (_req, res) => {
  try {
    res.status(200).json(service.getMembershipMap());
  } catch (error) {
    fail(res, error, 'get rotation membership');
  }
});

rotationGroupsRoutes.patch('/membership/:kind/:configId', (req, res) => {
  const { kind, configId } = req.params;
  if (!KINDS.includes(kind)) {
    return res.status(400).json({ message: 'Unknown member kind' });
  }
  const body: unknown = req.body ?? {};
  if (!isObject(body)) {
    return res.status(400).json({ message: 'Body must be an object' });
  }
  if (
    body.visibilityConfig !== undefined &&
    !isVisibility(body.visibilityConfig)
  ) {
    return res.status(400).json({ message: 'visibilityConfig is invalid' });
  }
  if (
    body.inactiveVisibilityConfig !== undefined &&
    !isVisibility(body.inactiveVisibilityConfig)
  ) {
    return res
      .status(400)
      .json({ message: 'inactiveVisibilityConfig is invalid' });
  }
  if (
    body.randomizeHomeOrder !== undefined &&
    typeof body.randomizeHomeOrder !== 'boolean'
  ) {
    return res
      .status(400)
      .json({ message: 'randomizeHomeOrder must be a boolean' });
  }
  try {
    return res
      .status(200)
      .json(
        service.patchOwn(
          kind as 'collection' | 'preExisting',
          configId,
          toPatch(body)
        )
      );
  } catch (error) {
    return fail(res, error, 'update membership settings');
  }
});

rotationGroupsRoutes.get('/poster/:ratingKey', async (req, res) => {
  const { ratingKey } = req.params;
  try {
    if (!/^\d+$/.test(ratingKey) || !service.isMemberRatingKey(ratingKey)) {
      return res.status(404).end();
    }
    const plex = await getPlexClient();
    const url = await plex.getCurrentPosterUrl(ratingKey);
    if (!url || !isTrustedPosterUrl(url)) return res.status(404).end();
    const upstream = await axios.get<ArrayBuffer>(
      url.startsWith('/') ? `${plexOrigin()}${url}` : url,
      {
        responseType: 'arraybuffer',
        timeout: 10000,
        maxRedirects: 0,
        maxContentLength: POSTER_MAX_BYTES,
        maxBodyLength: POSTER_MAX_BYTES,
      }
    );
    const type = String(upstream.headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!POSTER_TYPES.includes(type)) return res.status(404).end();
    res.setHeader('Content-Type', type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(200).send(Buffer.from(upstream.data));
  } catch (error) {
    logger.warn('Failed to load rotation poster', {
      label: LABEL,
      ratingKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(404).end();
  }
});

rotationGroupsRoutes.post('/', async (req, res) => {
  if (rejectIfBusy(res)) return;
  const message = validateGroupInput(req.body);
  if (message) return res.status(400).json({ message });
  try {
    const group = await service.createGroup(toGroupInput(req.body));
    rotationApply.kick();
    return res.status(201).json(group);
  } catch (error) {
    return fail(res, error, 'create rotation group');
  }
});

rotationGroupsRoutes.get('/:id/preview', async (req, res) => {
  const raw = req.query.steps;
  const steps = raw === undefined ? 1 : Number(raw);
  if (!Number.isInteger(steps) || steps < 1 || steps > 5) {
    return res
      .status(400)
      .json({ message: 'steps must be an integer from 1 to 5' });
  }
  try {
    return res
      .status(200)
      .json(await service.previewSaved(req.params.id, steps));
  } catch (error) {
    return fail(res, error, 'preview rotation group');
  }
});

rotationGroupsRoutes.post('/:id/rotate', async (req, res) => {
  if (rejectIfBusy(res)) return;
  try {
    const result = service.rotateNow(req.params.id);
    rotationApply.kick();
    const group = await service.getStatus(req.params.id);
    const body: RotateResult = { ...result, group };
    return res.status(202).json(body);
  } catch (error) {
    return fail(res, error, 'rotate group');
  }
});

rotationGroupsRoutes.post('/:id/queue', async (req, res) => {
  if (rejectIfBusy(res)) return;
  const key = isObject(req.body) ? req.body.moveToFront : undefined;
  if (typeof key !== 'string' || !key) {
    return res.status(400).json({ message: 'moveToFront is required' });
  }
  try {
    service.moveToFront(req.params.id, key);
    return res.status(200).json(await service.getStatus(req.params.id));
  } catch (error) {
    return fail(res, error, 'queue group member');
  }
});

rotationGroupsRoutes.get('/:id', async (req, res) => {
  try {
    res.status(200).json(await service.getStatus(req.params.id));
  } catch (error) {
    fail(res, error, 'get rotation group');
  }
});

rotationGroupsRoutes.put('/:id', async (req, res) => {
  if (rejectIfBusy(res)) return;
  const message = validateGroupInput(req.body);
  if (message) return res.status(400).json({ message });
  try {
    const group = await service.updateGroup(
      req.params.id,
      toGroupInput(req.body)
    );
    rotationApply.kick();
    return res.status(200).json(group);
  } catch (error) {
    return fail(res, error, 'update rotation group');
  }
});

rotationGroupsRoutes.delete('/:id', (req, res) => {
  if (rejectIfBusy(res)) return;
  try {
    service.deleteGroup(req.params.id);
    rotationApply.kick();
    return res.status(204).end();
  } catch (error) {
    return fail(res, error, 'delete rotation group');
  }
});

export default rotationGroupsRoutes;

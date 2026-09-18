import axios from 'axios';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: {
    overlays: { posterizarrIntegrationEnabled: false, jpegQuality: 95 },
    save: vi.fn(),
  },
  collections: { status: { running: false, pending: false } },
  overlays: { status: { running: false, pending: false } },
  trigger: { enqueue: vi.fn(), status: { running: false, queued: [] } },
}));

vi.mock('@server/lib/settings', () => ({ getSettings: () => mocks.settings }));
vi.mock('@server/lib/collectionsSync', () => ({ default: mocks.collections }));
vi.mock('@server/lib/overlayApplication', () => ({ default: mocks.overlays }));
vi.mock('@server/lib/posterizarrTrigger', () => ({ default: mocks.trigger }));
vi.mock('@server/middleware/auth', () => ({
  isAuthenticated: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));
vi.mock('@server/lib/overlays/LocalPosterFolderService', () => ({
  localPosterFolderService: {},
}));
vi.mock('@server/lib/overlays/PlexBasePosterDownloadJob', () => ({
  plexBasePosterDownloadJob: {},
}));
vi.mock('@server/lib/overlays/PosterResetJob', () => ({ posterResetJob: {} }));

import overlaySettingsRouter from './overlaySettings';
import posterizarrRouter from './posterizarr';

describe('Posterizarr callback and settings routes', () => {
  let server: Server;
  let baseURL: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/posterizarr', posterizarrRouter);
    app.use('/settings', overlaySettingsRouter);
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings.overlays = {
      posterizarrIntegrationEnabled: false,
      jpegQuality: 95,
    };
    mocks.collections.status = { running: false, pending: false };
    mocks.overlays.status = { running: false, pending: false };
    mocks.trigger.enqueue.mockReturnValue({
      queued: true,
      deduplicated: false,
      position: 1,
    });
  });

  const request = (
    method: 'get' | 'post' | 'put',
    url: string,
    data?: unknown
  ) =>
    axios({
      baseURL,
      method,
      url,
      data,
      proxy: false,
      validateStatus: () => true,
    });

  it('rejects callbacks and status reads while disabled without enqueueing work', async () => {
    expect(
      (await request('post', '/posterizarr/trigger', { ratingKey: '42' }))
        .status
    ).toBe(403);
    expect((await request('get', '/posterizarr/status')).status).toBe(403);
    expect(mocks.trigger.enqueue).not.toHaveBeenCalled();
  });

  it('persists the enable switch and retains it when changing output quality', async () => {
    expect(
      (
        await request('put', '/settings', {
          posterizarrIntegrationEnabled: true,
        })
      ).status
    ).toBe(200);
    expect(mocks.settings.save).toHaveBeenCalledTimes(1);
    expect(
      (await request('put', '/settings', { jpegQuality: 90 })).status
    ).toBe(200);
    expect(mocks.settings.overlays.posterizarrIntegrationEnabled).toBe(true);
    expect(mocks.settings.overlays.jpegQuality).toBe(90);
    expect(
      (await request('post', '/posterizarr/trigger', { ratingKey: ' 42 ' }))
        .status
    ).toBe(202);
    expect(mocks.trigger.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ ratingKey: '42' })
    );
  });

  it('rejects a non-boolean enable setting without saving it', async () => {
    expect(
      (
        await request('put', '/settings', {
          posterizarrIntegrationEnabled: 'false',
        })
      ).status
    ).toBe(400);
    expect(mocks.settings.save).not.toHaveBeenCalled();
  });

  it.each([
    ['collections', 'running'],
    ['collections', 'pending'],
    ['overlays', 'running'],
    ['overlays', 'pending'],
  ] as const)('rejects enqueues while %s is %s', async (job, state) => {
    mocks.settings.overlays.posterizarrIntegrationEnabled = true;
    mocks[job].status[state] = true;
    const response = await request('post', '/posterizarr/trigger', {
      ratingKey: '42',
    });
    expect(response.status).toBe(409);
    expect(response.headers['retry-after']).toBe('30');
    expect(mocks.trigger.enqueue).not.toHaveBeenCalled();
  });

  it('returns a retryable response when the queue is full', async () => {
    mocks.settings.overlays.posterizarrIntegrationEnabled = true;
    mocks.trigger.enqueue.mockReturnValue({
      queued: false,
      deduplicated: false,
      position: 0,
      rejected: true,
    });
    const response = await request('post', '/posterizarr/trigger', {
      ratingKey: '42',
    });
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('15');
    expect(response.data.retryable).toBe(true);
  });
});

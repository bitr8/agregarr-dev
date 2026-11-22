import express from 'express';
import fs from 'fs';
import type { Server } from 'http';
import os from 'os';
import path from 'path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

process.env.CONFIG_DIRECTORY = fs.mkdtempSync(
  path.join(os.tmpdir(), 'agregarr-preexisting-suffix-')
);

const stored = { id: 'pe-1', name: 'The Matrix', libraryId: '1' };
const updateSettings = vi.fn((_id: string, body: object) => ({
  ...stored,
  ...body,
}));
const syncState = { running: false, pending: false };
const syncSingle = vi.fn();

vi.mock('@server/middleware/auth', () => ({
  isAuthenticated: () => (_q: unknown, _r: unknown, n: () => void) => n(),
}));
vi.mock(
  '@server/lib/collections/services/PreExistingCollectionConfigService',
  () => ({
    preExistingCollectionConfigService: {
      getConfigs: () => [stored],
      updateSettings,
    },
  })
);
vi.mock('@server/routes/reorder', () => ({
  autoReorderLibrary: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@server/lib/collectionsSync', () => ({ default: syncState }));
vi.mock('@server/api/plexapi', () => ({ default: class {} }));
vi.mock('@server/lib/collections/plex/HubSyncService', () => ({
  HubSyncService: class {
    syncSinglePreExistingCollection = syncSingle;
  },
}));
vi.mock(
  '@server/lib/collections/core/CollectionUtilities',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    getAdminUser: vi.fn().mockResolvedValue({ plexToken: 'token' }),
  })
);

describe('pre-existing suffix and individual sync routes', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    const { default: routes } = await import('./preexisting');
    const app = express();
    app.use(express.json());
    app.use('/', routes);
    await new Promise<void>((r) => {
      server = app.listen(0, () => r());
    });
    base = `http://localhost:${(server.address() as { port: number }).port}`;
  }, 60_000);
  afterAll(() => server?.close());
  beforeEach(() => {
    updateSettings.mockClear();
    syncSingle.mockReset();
    syncState.running = false;
    syncState.pending = false;
  });

  const put = (body: object) =>
    fetch(`${base}/${stored.id}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const sync = (id: string) => fetch(`${base}/${id}/sync`, { method: 'POST' });

  it('saves a valid suffix mode and rejects an unknown one', async () => {
    const ok = await put({ collectionSuffixMode: 'strip' });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(updateSettings.mock.calls[0][1]).toMatchObject({
      collectionSuffixMode: 'strip',
    });

    const bad = await put({ collectionSuffixMode: 'shout' });
    expect(bad.status).toBe(400);
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });

  it('keeps the stored name over the copy the form loaded', async () => {
    const res = await put({ name: 'The Matrix Collection' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(updateSettings.mock.calls[0][1]).not.toHaveProperty('name');
  });

  it('syncs one collection', async () => {
    syncSingle.mockResolvedValue(true);
    const res = await sync(stored.id);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(syncSingle).toHaveBeenCalledWith(expect.anything(), stored.id);
  });

  it('reports a rename the sync could not apply', async () => {
    syncSingle.mockResolvedValue(true);
    const clean = await (await sync(stored.id)).json();
    expect(clean.renameFailed).toBe(false);

    Object.assign(stored, { collectionSuffixRenameFailed: true });
    try {
      const failed = await (await sync(stored.id)).json();
      expect(failed.renameFailed).toBe(true);
    } finally {
      delete (stored as { collectionSuffixRenameFailed?: boolean })
        .collectionSuffixRenameFailed;
    }
  });

  it('never accepts the failed flag from a client, and clears it when the mode changes', async () => {
    await put({ collectionSuffixRenameFailed: true });
    expect(updateSettings.mock.calls[0][1]).not.toHaveProperty(
      'collectionSuffixRenameFailed'
    );

    await put({ collectionSuffixMode: 'add' });
    expect(updateSettings.mock.calls[1][1]).toMatchObject({
      collectionSuffixRenameFailed: false,
    });
  });

  it('answers 404 for an unknown collection', async () => {
    syncSingle.mockResolvedValue(false);
    expect((await sync('missing')).status).toBe(404);
  });

  it('refuses while a full sync is running', async () => {
    syncState.running = true;
    expect((await sync(stored.id)).status).toBe(409);
    expect(syncSingle).not.toHaveBeenCalled();
  });

  it('refuses while a full sync is pending', async () => {
    syncState.pending = true;
    expect((await sync(stored.id)).status).toBe(409);
    expect(syncSingle).not.toHaveBeenCalled();
  });
});

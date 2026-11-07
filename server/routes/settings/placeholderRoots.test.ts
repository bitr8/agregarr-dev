import express from 'express';
import fs from 'fs';
import type { Server } from 'http';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agregarr-settings-'));
process.env.CONFIG_DIRECTORY = dir;

vi.mock('@server/middleware/auth', () => ({
  isAuthenticated: () => (_q: unknown, _r: unknown, n: () => void) => n(),
}));

describe('POST /main placeholder root folders', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    const { default: settingsRoutes } = await import('./index');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 1 }, session: { userId: 1 } });
      next();
    });
    app.use('/', settingsRoutes);
    await new Promise<void>((r) => {
      server = app.listen(0, () => r());
    });
    base = `http://localhost:${(server.address() as { port: number }).port}`;
  }, 60_000);
  afterAll(() => server?.close());

  const post = (body: object) =>
    fetch(`${base}/main`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const onDisk = () =>
    JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).main;

  it('persists a cleared field and drops keys the UI no longer sends', async () => {
    const r0 = await post({
      placeholderMovieRootFolders: { '1': '/mnt', '3': '/mnt', '4': '/mnt' },
      placeholderTVRootFolders: { '2': '/mnt' },
    });
    expect(r0.status, await r0.clone().text()).toBe(200);
    expect(onDisk().placeholderMovieRootFolders['4']).toBe('/mnt');

    await post({
      placeholderMovieRootFolders: { '1': '', '3': '/data/movies' },
      placeholderTVRootFolders: { '2': '' },
    });
    const main = onDisk();
    expect(main.placeholderMovieRootFolders).toEqual({ '3': '/data/movies' });
    expect(main.placeholderTVRootFolders).toEqual({});

    await post({ letterboxdUsePlainHttp: true });
    const after = onDisk();
    expect(after.placeholderMovieRootFolders).toEqual({ '3': '/data/movies' });
    expect(after.placeholderTVRootFolders).toEqual({});
  });
});

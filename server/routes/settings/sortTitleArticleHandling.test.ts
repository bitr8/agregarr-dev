import express from 'express';
import fs from 'fs';
import type { Server } from 'http';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.CONFIG_DIRECTORY = fs.mkdtempSync(
  path.join(os.tmpdir(), 'agregarr-settings-')
);

vi.mock('@server/middleware/auth', () => ({
  isAuthenticated: () => (_q: unknown, _r: unknown, n: () => void) => n(),
}));

describe('POST /plex sortTitleArticleHandling', () => {
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
    app.use(
      (
        err: { status?: number; message?: string },
        _q: express.Request,
        res: express.Response,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _n: express.NextFunction
      ) => res.status(err.status ?? 500).json({ message: err.message })
    );
    await new Promise<void>((r) => {
      server = app.listen(0, () => r());
    });
    base = `http://localhost:${(server.address() as { port: number }).port}`;
  }, 60_000);
  afterAll(() => server?.close());

  it('rejects an unknown mode instead of treating it as strip', async () => {
    const res = await fetch(`${base}/plex`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sortTitleArticleHandling: 'Strip' }),
    });
    expect(res.status).toBe(400);
  });
});

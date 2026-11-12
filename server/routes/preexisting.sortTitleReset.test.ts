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
  path.join(os.tmpdir(), 'agregarr-preexisting-')
);

const stored = {
  id: 'pe-1',
  name: 'Video Games',
  libraryId: '1',
  sortTitleOverride: 'ZZZ_Video Games',
};
const updateSettings = vi.fn((_id: string, body: object) => ({
  ...stored,
  ...body,
}));

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

describe('PUT /:id/settings sort title reset flag', () => {
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
  beforeEach(() => updateSettings.mockClear());

  const put = (body: object) =>
    fetch(`${base}/${stored.id}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const saved = () =>
    updateSettings.mock.calls[0][1] as Record<string, unknown>;

  it('ignores a stale flag posted back with an unchanged override', async () => {
    const res = await put({
      sortTitleOverride: stored.sortTitleOverride,
      sortTitleResetRequested: true,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(saved().sortTitleResetRequested).toBeUndefined();
  });

  it('sets the flag when the override is cleared', async () => {
    const res = await put({ sortTitleOverride: '' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(saved().sortTitleResetRequested).toBe(true);
  });
});

import express from 'express';
import type { Server } from 'http';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const settings = vi.hoisted(() => ({
  plex: {
    libraries: [{ key: '1', name: 'Movies', type: 'movie' }],
    collectionConfigs: [] as Record<string, unknown>[],
    hubConfigs: [],
    preExistingCollectionConfigs: [],
  },
  save: () => undefined,
  markCollectionModified: () => undefined,
}));

vi.mock('@server/api/plexapi', () => ({ default: class {} }));
vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/entity/User', () => ({ User: class {} }));
vi.mock('@server/middleware/auth', () => ({
  isAuthenticated: () => (_a: unknown, _b: unknown, next: () => void) => next(),
}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', async () => {
  const actual = await vi.importActual<object>('@server/lib/settings');
  return { ...actual, getSettings: () => settings };
});
vi.mock('@server/lib/collections/utils/TemplateEngine', () => ({
  templateEngine: {
    getDefaultContext: () => ({}),
    processTemplate: (t: string) => t,
  },
  TemplateEngine: class {},
}));
vi.mock('@server/lib/collections/services/LibraryCacheService', () => ({
  libraryCacheService: {},
}));
vi.mock(
  '@server/lib/collections/services/IndividualCollectionScheduler',
  () => ({
    IndividualCollectionScheduler: {
      refreshAllJobs: vi.fn(),
      cancelCollectionSync: vi.fn(),
    },
  })
);
vi.mock('@server/routes/reorder', () => ({
  autoReorderLibrary: vi.fn().mockResolvedValue(undefined),
}));

describe('PUT /:id/settings target user', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    const { default: routes } = await import('./collections');
    const app = express();
    app.use(express.json());
    app.use('/', routes);
    await new Promise<void>((r) => {
      server = app.listen(0, () => r());
    });
    base = `http://localhost:${(server.address() as { port: number }).port}`;
  }, 60_000);
  afterAll(() => server?.close());

  const put = async (id: string, body: object) =>
    fetch(`${base}/${id}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    settings.plex.collectionConfigs = [
      {
        id: 'c1',
        name: 'Trending',
        type: 'trakt',
        subtype: 'trending',
        libraryId: '1',
        libraryName: 'Movies',
        template: 'Trending',
        targetUserId: '42',
        targetUserLabel: 'viewer',
      },
      {
        id: 'c2',
        name: 'Genres',
        type: 'plex',
        subtype: 'genre',
        libraryId: '1',
        libraryName: 'Movies',
        template: '{value}',
        targetUserId: '42',
        targetUserLabel: 'viewer',
      },
    ];
  });

  it('drops a stale target user when the type does not support one', async () => {
    const res = await put('c2', { template: '{value}' });
    expect(res.status).toBe(200);
    const saved = settings.plex.collectionConfigs.find((c) => c.id === 'c2');
    expect(saved).not.toHaveProperty('targetUserId');
    expect(saved).not.toHaveProperty('targetUserLabel');
  });

  it('keeps it for a normal source', async () => {
    const res = await put('c1', { template: 'Trending' });
    expect(res.status).toBe(200);
    const saved = settings.plex.collectionConfigs.find((c) => c.id === 'c1');
    expect(saved?.targetUserId).toBe('42');
    expect(saved?.targetUserLabel).toBe('viewer');
  });
});

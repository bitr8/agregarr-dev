import express from 'express';
import fs from 'fs';
import type { Server } from 'http';
import yaml from 'js-yaml';
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
  path.join(os.tmpdir(), 'agregarr-rotation-routes-')
);

class RotationValidationError extends Error {}
class RotationNotFoundError extends Error {}

const svc = vi.hoisted(() => ({
  listStatus: vi.fn(),
  getStatus: vi.fn(),
  createGroup: vi.fn(),
  updateGroup: vi.fn(),
  deleteGroup: vi.fn(),
  previewDraft: vi.fn(),
  previewSaved: vi.fn(),
  rotateNow: vi.fn(),
  moveToFront: vi.fn(),
  listCandidates: vi.fn(),
  getMembershipMap: vi.fn(),
  patchOwn: vi.fn(),
  isMemberRatingKey: vi.fn(),
}));
const sync = vi.hoisted(() => ({
  collectionsStatus: { running: false, pending: false },
  applyStatus: { running: false },
  kick: vi.fn(),
}));

vi.mock('@server/middleware/auth', () => ({
  isAuthenticated: () => (_q: unknown, _r: unknown, n: () => void) => n(),
}));
vi.mock('@server/lib/rotation/RotationGroupService', () => ({
  RotationValidationError,
  RotationNotFoundError,
  rotationGroupService: svc,
}));
vi.mock('@server/lib/rotation/rotationApply', () => ({
  rotationApply: {
    get status() {
      return sync.applyStatus;
    },
    kick: sync.kick,
  },
}));
vi.mock('@server/lib/collectionsSync', () => ({
  default: {
    get status() {
      return sync.collectionsStatus;
    },
  },
}));
vi.mock('@server/lib/collections/core/CollectionUtilities', () => ({
  getAdminUser: vi.fn().mockResolvedValue({ plexToken: 'tok' }),
}));
const plexMock = vi.hoisted(() => ({ posterUrl: null as string | null }));
const axiosGet = vi.hoisted(() => vi.fn());
vi.mock('@server/api/plexapi', () => ({
  default: class {
    getCurrentPosterUrl = async () => plexMock.posterUrl;
  },
}));
vi.mock('axios', () => ({ default: { get: axiosGet } }));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    plex: { useSsl: false, ip: 'plex.test', port: 32400 },
  }),
}));

const validInput = () => ({
  name: 'Group One',
  libraryId: 'lib-1',
  enabled: true,
  slotCount: 2,
  interval: 'daily',
  order: 'sequential',
  surfaces: {
    usersHome: true,
    serverOwnerHome: false,
    libraryRecommended: false,
  },
  members: [{ kind: 'collection', configId: 'cfg-a' }],
});

describe('rotation groups routes', () => {
  let server: Server;
  let base = '';
  let router: express.Router;

  beforeAll(async () => {
    const mod = await import('./rotationGroups');
    router = mod.default;
    const app = express();
    app.use(express.json());
    app.use('/', router);
    await new Promise<void>((r) => {
      server = app.listen(0, () => r());
    });
    base = `http://localhost:${(server.address() as { port: number }).port}`;
  }, 60_000);
  afterAll(() => server?.close());

  beforeEach(() => {
    Object.values(svc).forEach((f) => f.mockReset());
    sync.kick.mockReset();
    sync.collectionsStatus.running = false;
    sync.collectionsStatus.pending = false;
    sync.applyStatus.running = false;
    svc.getStatus.mockResolvedValue({ id: 'g-1' });
    svc.createGroup.mockResolvedValue({ id: 'g-1' });
    svc.updateGroup.mockResolvedValue({ id: 'g-1' });
    svc.rotateNow.mockReturnValue({ rotated: true });
    svc.listStatus.mockResolvedValue([]);
    svc.listCandidates.mockResolvedValue([]);
    svc.getMembershipMap.mockReturnValue({});
    svc.previewSaved.mockResolvedValue({ steps: [] });
    svc.previewDraft.mockResolvedValue({});
    svc.patchOwn.mockReturnValue({});
  });

  const call = (method: string, p: string, body?: unknown) =>
    fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('the spec accepts the cache query the service puts on poster urls', () => {
    const spec = yaml.load(
      fs.readFileSync(path.resolve(process.cwd(), 'agregarr-api.yml'), 'utf8')
    ) as {
      paths: Record<
        string,
        { get?: { parameters?: { name: string; in: string }[] } }
      >;
    };
    const params =
      spec.paths['/rotation-groups/poster/{ratingKey}'].get?.parameters ?? [];
    const service = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'server/lib/rotation/RotationGroupService.ts'
      ),
      'utf8'
    );
    const used = [
      ...service.matchAll(/rotation-groups\/poster\/\$\{[^}]+\}\?(\w+)=/g),
    ].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) {
      expect(params.some((p) => p.in === 'query' && p.name === name)).toBe(
        true
      );
    }
  });

  it('declares every registered route in agregarr-api.yml', () => {
    const spec = yaml.load(
      fs.readFileSync(path.resolve(process.cwd(), 'agregarr-api.yml'), 'utf8')
    ) as { paths: Record<string, Record<string, unknown>> };
    const stack = (
      router as unknown as {
        stack: {
          route?: { path: string; methods: Record<string, boolean> };
        }[];
      }
    ).stack;
    const routes = stack
      .filter((l) => l.route)
      .map((l) => l.route as NonNullable<typeof l.route>);
    expect(routes.length).toBe(13);
    for (const r of routes) {
      const specPath =
        '/rotation-groups' +
        (r.path === '/' ? '' : r.path.replace(/:(\w+)/g, '{$1}'));
      for (const method of Object.keys(r.methods)) {
        expect(
          spec.paths[specPath]?.[method],
          `${method} ${specPath}`
        ).toBeDefined();
      }
    }
  });

  it('lists groups', async () => {
    const res = await call('GET', '/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ groups: [] });
  });

  describe('validation', () => {
    const cases: [string, (b: Record<string, unknown>) => void][] = [
      ['empty name', (b) => (b.name = '  ')],
      ['long name', (b) => (b.name = 'x'.repeat(61))],
      ['missing libraryId', (b) => delete b.libraryId],
      ['non-boolean enabled', (b) => (b.enabled = 'yes')],
      ['slotCount 0', (b) => (b.slotCount = 0)],
      ['slotCount 21', (b) => (b.slotCount = 21)],
      ['fractional slotCount', (b) => (b.slotCount = 1.5)],
      ['bad interval', (b) => (b.interval = 'hourly')],
      ['weekly without weekday', (b) => (b.interval = 'weekly')],
      ['weekday 7', (b) => (b.weekday = 7)],
      ['bad order', (b) => (b.order = 'random')],
      [
        'no surface on',
        (b) =>
          (b.surfaces = {
            usersHome: false,
            serverOwnerHome: false,
            libraryRecommended: false,
          }),
      ],
      ['partial surfaces', (b) => (b.surfaces = { usersHome: true })],
      ['members not array', (b) => (b.members = 'x')],
      [
        'too many members',
        (b) =>
          (b.members = Array.from({ length: 501 }, (_, i) => ({
            kind: 'collection',
            configId: `c${i}`,
          }))),
      ],
      [
        'bad member kind',
        (b) => (b.members = [{ kind: 'hub', configId: 'a' }]),
      ],
    ];
    for (const [label, mutate] of cases) {
      it(`400 on ${label}`, async () => {
        const body = validInput() as Record<string, unknown>;
        mutate(body);
        for (const [method, p] of [
          ['POST', '/'],
          ['PUT', '/g-1'],
          ['POST', '/preview'],
        ]) {
          const res = await call(method, p, body);
          expect(res.status, `${method} ${p}`).toBe(400);
          expect((await res.json()).message).toBeTruthy();
        }
        expect(svc.createGroup).not.toHaveBeenCalled();
        expect(svc.updateGroup).not.toHaveBeenCalled();
      });
    }

    it('does not pass stray properties to the service', async () => {
      const body = {
        ...validInput(),
        evil: 1,
        surfaces: { ...validInput().surfaces, extra: true },
        members: [{ kind: 'collection', configId: 'cfg-a', extra: 1 }],
      };
      await call('POST', '/', body);
      expect(svc.createGroup).toHaveBeenCalledWith(validInput());
      await call('PATCH', '/membership/collection/cfg-a', {
        randomizeHomeOrder: true,
        stash: 'x',
      });
      expect(svc.patchOwn).toHaveBeenCalledWith('collection', 'cfg-a', {
        randomizeHomeOrder: true,
      });
    });

    it('accepts a valid weekly group', async () => {
      const res = await call('POST', '/', {
        ...validInput(),
        interval: 'weekly',
        weekday: 0,
      });
      expect(res.status).toBe(201);
    });

    it('400 on steps out of range', async () => {
      for (const s of ['0', '6', 'x']) {
        expect((await call('GET', `/g-1/preview?steps=${s}`)).status).toBe(400);
      }
      expect((await call('GET', '/g-1/preview?steps=3')).status).toBe(200);
      expect(svc.previewSaved).toHaveBeenCalledWith('g-1', 3);
    });

    it('400 on queue without moveToFront', async () => {
      expect((await call('POST', '/g-1/queue', {})).status).toBe(400);
    });

    it('400 on bad membership patch', async () => {
      expect((await call('PATCH', '/membership/hub/cfg-a', {})).status).toBe(
        400
      );
      expect(
        (
          await call('PATCH', '/membership/collection/cfg-a', {
            visibilityConfig: { usersHome: true },
          })
        ).status
      ).toBe(400);
      expect(
        (
          await call('PATCH', '/membership/collection/cfg-a', {
            randomizeHomeOrder: 'no',
          })
        ).status
      ).toBe(400);
      expect(
        (
          await call('PATCH', '/membership/collection/cfg-a', {
            randomizeHomeOrder: true,
          })
        ).status
      ).toBe(200);
    });
  });

  describe('error mapping', () => {
    it('maps service validation errors to 400', async () => {
      svc.createGroup.mockRejectedValue(
        new RotationValidationError('dup name')
      );
      const res = await call('POST', '/', validInput());
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ message: 'dup name' });
    });

    it('404 for an unknown id on every id route', async () => {
      const err = new RotationNotFoundError('nope');
      svc.getStatus.mockRejectedValue(err);
      svc.updateGroup.mockRejectedValue(err);
      svc.previewSaved.mockRejectedValue(err);
      svc.rotateNow.mockImplementation(() => {
        throw err;
      });
      svc.deleteGroup.mockImplementation(() => {
        throw err;
      });
      svc.moveToFront.mockImplementation(() => {
        throw err;
      });
      expect((await call('GET', '/missing')).status).toBe(404);
      expect((await call('PUT', '/missing', validInput())).status).toBe(404);
      expect((await call('DELETE', '/missing')).status).toBe(404);
      expect((await call('GET', '/missing/preview')).status).toBe(404);
      expect((await call('POST', '/missing/rotate')).status).toBe(404);
      expect(
        (await call('POST', '/missing/queue', { moveToFront: 'collection:a' }))
          .status
      ).toBe(404);
    });

    it('500 with the house shape on unexpected errors', async () => {
      svc.listStatus.mockRejectedValue(new Error('boom'));
      const res = await call('GET', '/');
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: 'Failed to list rotation groups',
        message: 'boom',
      });
    });
  });

  describe('concurrency', () => {
    const mutations = (): [string, string, unknown?][] => [
      ['POST', '/', validInput()],
      ['PUT', '/g-1', validInput()],
      ['DELETE', '/g-1'],
      ['POST', '/g-1/rotate'],
      ['POST', '/g-1/queue', { moveToFront: 'collection:a' }],
    ];
    const states: [string, () => void][] = [
      ['sync running', () => (sync.collectionsStatus.running = true)],
      ['sync pending', () => (sync.collectionsStatus.pending = true)],
      ['apply running', () => (sync.applyStatus.running = true)],
    ];

    for (const [label, set] of states) {
      it(`409 on mutations and 200 on reads while ${label}`, async () => {
        set();
        for (const [m, p, b] of mutations()) {
          const res = await call(m, p, b);
          expect(res.status, `${m} ${p}`).toBe(409);
          expect((await res.json()).code).toBe('SYNC_RUNNING');
        }
        expect(svc.createGroup).not.toHaveBeenCalled();
        expect(svc.rotateNow).not.toHaveBeenCalled();
        expect(sync.kick).not.toHaveBeenCalled();
        for (const p of [
          '/',
          '/g-1',
          '/g-1/preview',
          '/candidates',
          '/membership',
        ]) {
          expect((await call('GET', p)).status, p).toBe(200);
        }
        expect((await call('POST', '/preview', validInput())).status).toBe(200);
        expect(
          (await call('PATCH', '/membership/collection/cfg-a', {})).status
        ).toBe(200);
      });
    }
  });

  describe('kick', () => {
    it('rotate returns 202 with the fresh status and leaves apply to the service', async () => {
      const res = await call('POST', '/g-1/rotate');
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ rotated: true, group: { id: 'g-1' } });
      expect(svc.rotateNow).toHaveBeenCalledWith('g-1');
      expect(sync.kick).not.toHaveBeenCalled();
    });

    it('create, update and delete leave apply to the service', async () => {
      await call('POST', '/', validInput());
      await call('PUT', '/g-1', validInput());
      expect((await call('DELETE', '/g-1')).status).toBe(204);
      expect(sync.kick).not.toHaveBeenCalled();
    });

    it('queue passes the member key through', async () => {
      const res = await call('POST', '/g-1/queue', {
        moveToFront: 'collection:cfg-a',
      });
      expect(res.status).toBe(200);
      expect(svc.moveToFront).toHaveBeenCalledWith('g-1', 'collection:cfg-a');
    });
  });

  describe('poster', () => {
    it('handler rejects non-digit rating keys without asking the service (the spec pattern answers 400 first in production)', async () => {
      for (const k of ['abc', '12a', '1.5']) {
        expect((await call('GET', `/poster/${k}`)).status, k).toBe(404);
      }
      expect(svc.isMemberRatingKey).not.toHaveBeenCalled();
    });

    it('404 for rating keys that are not members', async () => {
      svc.isMemberRatingKey.mockReturnValue(false);
      expect((await call('GET', '/poster/123')).status).toBe(404);
      expect(svc.isMemberRatingKey).toHaveBeenCalledWith('123');
    });

    describe('proxy', () => {
      const okUrl =
        'http://plex.test:32400/library/metadata/1/thumb?X-Plex-Token=tok';
      beforeEach(() => {
        svc.isMemberRatingKey.mockReturnValue(true);
        axiosGet.mockReset();
        plexMock.posterUrl = okUrl;
      });

      it('streams an allowed image with hardened options', async () => {
        axiosGet.mockResolvedValue({
          data: new Uint8Array([1, 2, 3]).buffer,
          headers: { 'content-type': 'image/png; charset=x' },
        });
        const res = await call('GET', '/poster/123');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/png');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('cache-control')).toBe('private, max-age=300');
        expect(axiosGet.mock.calls[0][1]).toMatchObject({
          maxRedirects: 0,
          timeout: 10000,
          maxContentLength: 10 * 1024 * 1024,
          maxBodyLength: 10 * 1024 * 1024,
        });
      });

      it('404 for an off-origin poster URL without fetching', async () => {
        plexMock.posterUrl = 'http://evil.test/poster.png';
        expect((await call('GET', '/poster/123')).status).toBe(404);
        expect(axiosGet).not.toHaveBeenCalled();
      });

      it('404 for a disallowed content type', async () => {
        for (const type of ['image/svg+xml', 'text/html']) {
          axiosGet.mockResolvedValue({
            data: new ArrayBuffer(1),
            headers: { 'content-type': type },
          });
          expect((await call('GET', '/poster/123')).status, type).toBe(404);
        }
      });
    });
  });
});

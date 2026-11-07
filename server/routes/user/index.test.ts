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

const store = vi.hoisted(() => ({
  users: new Map<number, Record<string, unknown>>(),
  saved: [] as number[],
}));

vi.mock('@server/datasource', () => ({
  getRepository: () => ({
    findOneOrFail: async ({ where }: { where: { id: number } }) => {
      const u = store.users.get(where.id);
      if (!u) throw new Error('missing');
      return u;
    },
    save: async (u: { id: number }) => {
      store.saved.push(u.id);
      return u;
    },
  }),
}));
vi.mock('@server/entity/User', () => ({ User: class User {} }));

import userRoutes from './index';

let server: Server;
let base: string;
let actor: number | undefined;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (actor !== undefined) (req as { user?: unknown }).user = { id: actor };
    next();
  });
  app.use('/user', userRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(err.status ?? 500).json({ message: err.message })
  );
  await new Promise<void>((r) => {
    server = app.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  store.saved = [];
  store.users = new Map([
    [
      1,
      {
        id: 1,
        username: 'owner',
        displayName: 'Owner',
        email: 'o@example.test',
        filter() {
          return { id: 1 };
        },
      },
    ],
    [
      5,
      {
        id: 5,
        username: 'u5',
        displayName: 'U5',
        email: 'u5@example.test',
        filter() {
          return { id: 5 };
        },
      },
    ],
    [
      6,
      {
        id: 6,
        username: 'u6',
        displayName: 'U6',
        email: 'u6@example.test',
        filter() {
          return { id: 6 };
        },
      },
    ],
  ]);
  actor = 5;
});

const post = (id: number, body: object) =>
  fetch(`${base}/user/${id}/settings/main`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('user routes by id', () => {
  it('blocks a normal user from reading another user', async () => {
    expect((await fetch(`${base}/user/1`)).status).toBe(403);
    expect((await fetch(`${base}/user/1/settings/main`)).status).toBe(403);
  });

  it('blocks a normal user from rewriting another user', async () => {
    const res = await post(1, { email: 'attacker@example.test' });
    expect(res.status).toBe(403);
    expect(store.saved).toEqual([]);
    expect(store.users.get(1)?.email).toBe('o@example.test');
  });

  it('lets a user read and update themselves', async () => {
    expect((await fetch(`${base}/user/5`)).status).toBe(200);
    expect((await fetch(`${base}/user/5/settings/main`)).status).toBe(200);
    expect((await post(5, { displayName: 'New' })).status).toBe(200);
    expect(store.saved).toEqual([5]);
  });

  it('lets the owner act on any user', async () => {
    actor = 1;
    expect((await fetch(`${base}/user/6`)).status).toBe(200);
    expect((await post(6, { displayName: 'Set by owner' })).status).toBe(200);
    expect(store.saved).toEqual([6]);
  });

  it('rejects an unauthenticated actor', async () => {
    actor = undefined;
    expect((await fetch(`${base}/user/5`)).status).toBe(403);
  });
});

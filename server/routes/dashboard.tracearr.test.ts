import axios from 'axios';
import express from 'express';
import fs from 'fs';
import type { Server } from 'http';
import yaml from 'js-yaml';
import type { AddressInfo } from 'net';
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

const mocks = vi.hoisted(() => ({
  settings: {
    tautulli: {} as Record<string, unknown>,
    tracearr: undefined as Record<string, unknown> | undefined,
    plex: {
      collectionConfigs: [{ collectionRatingKey: '10' }],
      preExistingCollectionConfigs: [] as unknown[],
    },
  },
  topCollections: vi.fn(),
  homeStats: vi.fn(),
  tracearrInputs: vi.fn(),
  tracearrCollections: vi.fn(),
}));

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/entity/JobRunHistory', () => ({ JobRunHistory: class {} }));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', () => ({ getSettings: () => mocks.settings }));
vi.mock('@server/middleware/auth', () => ({
  isAuthenticated: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));
vi.mock('@server/api/tautulli', () => ({
  default: class {
    getTopCollections = mocks.topCollections;
    getHomeStats = mocks.homeStats;
  },
}));
vi.mock('@server/lib/statistics/tracearrDashboard', () => ({
  getTracearrDashboardInputs: mocks.tracearrInputs,
  getTracearrCollectionStats: mocks.tracearrCollections,
}));

import dashboardRoutes from './dashboard';

const tracearrOn = {
  enabled: true,
  hostname: 'tracearr.example',
  apiKey: 'k',
};

describe('dashboard statistics provider switch', () => {
  let server: Server;
  let baseURL: string;

  beforeAll(async () => {
    const app = express();
    app.use('/dashboard', dashboardRoutes);
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
    mocks.settings.tautulli = { hostname: 'tautulli.example', apiKey: 't' };
    mocks.settings.tracearr = undefined;
    mocks.topCollections.mockResolvedValue([
      { title: 'Movie Night', media_type: 'collection', total_plays: 7 },
    ]);
    mocks.homeStats.mockImplementation(
      async (_d: number, _t: string, statId: string) =>
        statId === 'top_movies'
          ? [{ total_plays: 5 }, { total_plays: 3 }]
          : [{ total_plays: 2 }]
    );
  });

  const stats = async () =>
    (await axios.get(`${baseURL}/dashboard/stats`)).data as Record<
      string,
      unknown
    >;

  it('keeps the Tautulli response unchanged when Tracearr is unset', async () => {
    const body = await stats();

    expect(mocks.tracearrInputs).not.toHaveBeenCalled();
    expect(Object.keys(body).sort()).toEqual([
      'activity',
      'collections',
      'tautulli',
      'timestamp',
    ]);
    expect(body.tautulli).toEqual({
      isConnected: true,
      weeklyActivity: {
        totalPlays: 10,
        moviePlays: 8,
        tvPlays: 2,
        collectionPlays: 7,
      },
    });
    expect(body.collections).toMatchObject({
      agregarr: 1,
      preExisting: 0,
      total: 1,
      stats: {
        totalCollections: 1,
        collectionPlays: { total: 7, movies: 7, tv: 0 },
      },
    });
  });

  it('ignores a disabled or incomplete Tracearr config', async () => {
    for (const tracearr of [
      { ...tracearrOn, enabled: false },
      { ...tracearrOn, apiKey: undefined },
    ]) {
      mocks.settings.tracearr = tracearr;
      const body = await stats();
      expect(body.statisticsProvider).toBeUndefined();
    }
    expect(mocks.tracearrInputs).not.toHaveBeenCalled();
  });

  it('uses Tracearr numbers when enabled, without Tautulli configured', async () => {
    mocks.settings.tautulli = {};
    mocks.settings.tracearr = tracearrOn;
    mocks.tracearrInputs.mockResolvedValue([
      [{ title: 'Show Night', media_type: 'collection', total_plays: 4 }],
      [{ total_plays: 6 }],
      [{ total_plays: 1 }],
    ]);

    const body = await stats();

    expect(mocks.homeStats).not.toHaveBeenCalled();
    expect(mocks.tracearrInputs).toHaveBeenCalledWith(['10']);
    expect(body.statisticsProvider).toBe('tracearr');
    expect(body.tautulli).toMatchObject({
      isConnected: true,
      weeklyActivity: { moviePlays: 6, tvPlays: 1, totalPlays: 7 },
    });
  });

  it('reports a Tracearr outage as disconnected instead of empty stats', async () => {
    mocks.settings.tracearr = tracearrOn;
    mocks.tracearrInputs.mockRejectedValue(new Error('[Tracearr] down'));

    const body = await stats();

    expect(body.tautulli).toEqual({
      isConnected: false,
      error: '[Tracearr] down',
    });
    expect(body.activity).toBeNull();
  });

  it('clamps collection stats days to 365 for Tracearr', async () => {
    mocks.settings.tracearr = tracearrOn;
    mocks.tracearrCollections.mockResolvedValue([]);

    const res = await axios.get(
      `${baseURL}/dashboard/collections?days=9999&statType=plays&limit=5`
    );

    expect(mocks.tracearrCollections).toHaveBeenCalledWith(
      expect.objectContaining({ days: 365, limit: 5 })
    );
    expect(res.data.metadata).toMatchObject({
      days: 365,
      statisticsProvider: 'tracearr',
    });
  });

  it('passes the requested days through untouched for Tautulli', async () => {
    mocks.topCollections.mockResolvedValue([]);
    const res = await axios.get(`${baseURL}/dashboard/collections?days=9999`);
    expect(mocks.topCollections).toHaveBeenCalledWith(10, 'plays', 9999, [
      '10',
    ]);
    expect(res.data.metadata.statisticsProvider).toBeUndefined();
  });

  it('keeps the not-configured error when neither provider is set up', async () => {
    mocks.settings.tautulli = {};
    const err = await axios
      .get(`${baseURL}/dashboard/collections`)
      .catch((e) => e);
    expect(err.response.status).toBe(400);
    expect(err.response.data.error).toBe('Tautulli not configured');
  });
});

describe('Tracearr settings OpenAPI contract', () => {
  it('registers the settings routes for runtime validation', () => {
    const spec = yaml.load(
      fs.readFileSync(path.resolve(process.cwd(), 'agregarr-api.yml'), 'utf8')
    ) as { paths: Record<string, { get?: unknown; post?: unknown }> };

    expect(spec.paths['/settings/tracearr'].get).toBeDefined();
    expect(spec.paths['/settings/tracearr'].post).toBeDefined();
    expect(spec.paths['/settings/tracearr/test'].post).toBeDefined();
  });
});

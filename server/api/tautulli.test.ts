import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const get = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { create: () => ({ get }) } }));

import TautulliAPI from './tautulli';

const ok = (data: unknown) => ({ data: { response: { data } } });

const callsOf = (cmd: string) =>
  get.mock.calls.filter(([, cfg]) => cfg.params.cmd === cmd).length;

// 10 collections: keys 1-8 have plays (key n => n plays), 9 and 10 have none
const mockTautulli = () => {
  get.mockImplementation(async (_url, cfg) => {
    const { cmd, rating_key, query_days } = cfg.params;
    if (cmd === 'get_item_watch_time_stats') {
      const n = Number(rating_key);
      return ok(
        String(query_days)
          .split(',')
          .map((d) => ({
            query_days: Number(d),
            total_plays: n <= 8 ? n * Number(d) : 0,
            total_time: n * 100,
          }))
      );
    }
    if (cmd === 'get_metadata') return ok({ title: `C${rating_key}` });
    return ok([]);
  });
};

const keys = Array.from({ length: 10 }, (_, i) => `${i + 1}`);
const api = () => new TautulliAPI({ hostname: 'h', apiKey: 'k' } as never);

describe('TautulliAPI.getTopCollections', () => {
  beforeEach(() => {
    get.mockReset();
    mockTautulli();
  });

  it('fetches details only for the top `limit` collections with plays', async () => {
    const result = await api().getTopCollections(3, 'plays', 11, keys);

    expect(result.map((c) => c.rating_key)).toEqual(['8', '7', '6']);
    expect(callsOf('get_item_watch_time_stats')).toBe(10);
    expect(callsOf('get_metadata')).toBe(3);
    expect(callsOf('get_item_user_stats')).toBe(3);
  });

  it('caps detail calls at the number of collections with plays', async () => {
    await api().getTopCollections(50, 'duration', 12, keys);

    expect(callsOf('get_metadata')).toBe(8);
    expect(callsOf('get_item_user_stats')).toBe(8);
  });

  it('reuses the watch-time pass within the TTL', async () => {
    await api().getTopCollections(50, 'plays', 13, keys);
    await api().getTopCollections(8, 'duration', 13, [...keys].reverse());

    expect(callsOf('get_item_watch_time_stats')).toBe(10);
  });

  it('shares one pass between concurrent calls', async () => {
    await Promise.all([
      api().getTopCollections(50, 'plays', 14, keys),
      api().getTopCollections(8, 'plays', 14, keys),
    ]);

    expect(callsOf('get_item_watch_time_stats')).toBe(10);
  });

  it('serves the 7-day and 30-day dashboard calls from one pass', async () => {
    const week = await api().getTopCollections(50, 'plays', 7, keys);
    const month = await api().getTopCollections(8, 'plays', 30, keys);

    expect(callsOf('get_item_watch_time_stats')).toBe(10);
    expect(week.find((c) => c.rating_key === '8')?.total_plays).toBe(56);
    expect(month.find((c) => c.rating_key === '8')?.total_plays).toBe(240);
  });

  it('does not cache a pass where a collection call failed', async () => {
    let failed = false;
    const base = get.getMockImplementation() as (
      u: string,
      c: unknown
    ) => unknown;
    get.mockImplementation(async (url, cfg) => {
      if (!failed && cfg.params.rating_key === '3') {
        failed = true;
        throw new Error('boom');
      }
      return base(url, cfg);
    });

    const first = await api().getTopCollections(50, 'plays', 15, keys);
    expect(first.map((c) => c.rating_key)).not.toContain('3');

    const second = await api().getTopCollections(50, 'plays', 15, keys);
    expect(second.map((c) => c.rating_key)).toContain('3');
    expect(callsOf('get_item_watch_time_stats')).toBe(20);
  });

  it('treats a missing requested-day row as no plays', async () => {
    get.mockImplementation(async (_url, cfg) =>
      cfg.params.cmd === 'get_item_watch_time_stats'
        ? ok([{ query_days: 7, total_plays: 5, total_time: 500 }])
        : ok({})
    );

    const result = await api().getTopCollections(50, 'plays', 16, keys);

    expect(result).toEqual([]);
  });

  it('reuses detail calls on repeat and across the 7/30 day views', async () => {
    const own = keys.slice(0, 9);
    await api().getTopCollections(50, 'plays', 7, own);
    await api().getTopCollections(8, 'plays', 30, own);
    await api().getTopCollections(50, 'plays', 7, own);

    expect(callsOf('get_metadata')).toBe(8);
    expect(callsOf('get_item_user_stats')).toBe(8);
  });

  it.each([
    ['get_metadata', 24],
    ['get_item_user_stats', 25],
  ])('does not memoize a failed %s call', async (failingCmd, days) => {
    const base = get.getMockImplementation() as (
      u: string,
      c: unknown
    ) => Promise<unknown>;
    let failed = false;
    get.mockImplementation(async (url, cfg) => {
      if (!failed && cfg.params.cmd === failingCmd) {
        failed = true;
        throw new Error('boom');
      }
      return base(url, cfg);
    });

    await api().getTopCollections(2, 'plays', days, keys);
    await api().getTopCollections(2, 'plays', days, keys);

    expect(callsOf(failingCmd)).toBe(3);
  });

  it('shares in-flight detail calls between overlapping requests', async () => {
    const base = get.getMockImplementation() as (
      u: string,
      c: unknown
    ) => Promise<unknown>;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    get.mockImplementation(async (url, cfg) => {
      if (cfg.params.cmd !== 'get_item_watch_time_stats') await gate;
      return base(url, cfg);
    });

    const a = api().getTopCollections(2, 'plays', 26, keys);
    const b = api().getTopCollections(2, 'plays', 26, keys);
    await new Promise((r) => setTimeout(r, 0));
    release();
    await Promise.all([a, b]);

    expect(callsOf('get_metadata')).toBe(2);
    expect(callsOf('get_item_user_stats')).toBe(2);
  });

  it('drops details together with an evicted partial pass', async () => {
    const base = get.getMockImplementation() as (
      u: string,
      c: unknown
    ) => Promise<unknown>;
    let failed = false;
    get.mockImplementation(async (url, cfg) => {
      if (
        !failed &&
        cfg.params.cmd === 'get_item_watch_time_stats' &&
        cfg.params.rating_key === '3'
      ) {
        failed = true;
        throw new Error('boom');
      }
      return base(url, cfg);
    });

    await api().getTopCollections(2, 'plays', 21, keys);
    await api().getTopCollections(2, 'plays', 21, keys);

    expect(callsOf('get_metadata')).toBe(4);
  });

  describe('pass lifetime', () => {
    afterEach(() => vi.useRealTimers());

    it('keeps sharing a pass that runs longer than the TTL', async () => {
      vi.useFakeTimers();
      const base = get.getMockImplementation() as (
        u: string,
        c: unknown
      ) => Promise<unknown>;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      get.mockImplementation(async (url, cfg) => {
        if (cfg.params.rating_key === '5') await gate;
        return base(url, cfg);
      });

      const first = api().getTopCollections(50, 'plays', 17, keys);
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
      const second = api().getTopCollections(50, 'plays', 17, keys);
      release();
      await Promise.all([first, second]);

      expect(callsOf('get_item_watch_time_stats')).toBe(10);
    });
  });
});

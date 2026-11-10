import serversFixture from '@server/api/__fixtures__/tracearr-servers.json';
import movieFixture from '@server/api/__fixtures__/tracearr-top-media-movie-365.json';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { get, create } = vi.hoisted(() => {
  const get = vi.fn();
  return { get, create: vi.fn(() => ({ get })) };
});

vi.mock('axios', () => ({ default: { create } }));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import TracearrAPI from './tracearr';

let hostCounter = 0;
const newApi = (extra: Record<string, unknown> = {}) =>
  new TracearrAPI(
    {
      hostname: `tracearr-${hostCounter++}.test`,
      port: 3000,
      apiKey: 'test-key',
      ...extra,
    },
    async () => undefined
  );

const page = (rows: unknown[], nextCursor: string | null) => ({
  data: { data: rows, meta: { nextCursor, pageSize: 1000 } },
});

const httpError = (status: number, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, headers },
  });

describe('TracearrAPI', () => {
  beforeEach(() => {
    get.mockReset();
    create.mockClear();
  });

  it('sends the bearer key to the public v2 base', () => {
    newApi({ useSsl: true, urlBase: '/trr' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: expect.stringMatching(
          /^https:\/\/tracearr-\d+\.test:3000\/trr\/api\/v2\/public$/
        ),
        headers: { Authorization: 'Bearer test-key' },
      })
    );
  });

  it('follows cursors and stops when nextCursor is null', async () => {
    get
      .mockResolvedValueOnce(page(movieFixture.data.slice(0, 10), 'c1'))
      .mockResolvedValueOnce(page(movieFixture.data.slice(10, 25), null));

    const result = await newApi().getTopMedia({
      mediaType: 'movie',
      days: 365,
      sort: 'plays',
    });

    expect(result.rows).toHaveLength(25);
    expect(result.truncated).toBe(false);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1][1].params.cursor).toBe('c1');
    expect(get.mock.calls[0][1].params).toMatchObject({
      media_type: 'movie',
      days: 365,
      sort: 'plays',
      pageSize: 1000,
    });
  });

  it('stops at the page cap and flags truncation', async () => {
    get.mockResolvedValue(page(movieFixture.data.slice(0, 3), 'more'));

    const result = await newApi().getTopMedia({
      mediaType: 'movie',
      days: 30,
      sort: 'plays',
      maxPages: 2,
    });

    expect(get).toHaveBeenCalledTimes(2);
    expect(result.rows).toHaveLength(6);
    expect(result.truncated).toBe(true);
  });

  it('stops early when shouldStop matches the last row', async () => {
    get.mockResolvedValue(page(movieFixture.data.slice(0, 3), 'more'));

    const result = await newApi().getTopMedia({
      mediaType: 'movie',
      days: 30,
      sort: 'viewers',
      shouldStop: () => true,
    });

    expect(get).toHaveBeenCalledTimes(1);
    expect(result.truncated).toBe(false);
  });

  it('clamps days to 1-365 and sends server_id only when set', async () => {
    get.mockResolvedValue(page([], null));

    await newApi().getTopMedia({
      mediaType: 'show',
      days: 9999,
      sort: 'plays',
    });
    await newApi({ serverId: 'srv-1' }).getTopMedia({
      mediaType: 'show',
      days: 0,
      sort: 'plays',
    });

    expect(get.mock.calls[0][1].params.days).toBe(365);
    expect(get.mock.calls[0][1].params.server_id).toBeUndefined();
    expect(get.mock.calls[1][1].params.days).toBe(30);
    expect(get.mock.calls[1][1].params.server_id).toBe('srv-1');
  });

  it('honours Retry-After on 429, then succeeds', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const api = new TracearrAPI({ hostname: 'retry.test', apiKey: 'k' }, sleep);
    get
      .mockRejectedValueOnce(httpError(429, { 'retry-after': '7' }))
      .mockResolvedValueOnce(page([], null));

    await api.getTopMedia({ mediaType: 'movie', days: 7, sort: 'plays' });

    expect(sleep).toHaveBeenCalledWith(7000);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('fails after the retry budget on persistent 429', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const api = new TracearrAPI(
      { hostname: 'retry-fail.test', apiKey: 'k' },
      sleep
    );
    get.mockRejectedValue(httpError(429, { 'retry-after': '1' }));

    await expect(
      api.getTopMedia({ mediaType: 'movie', days: 7, sort: 'plays' })
    ).rejects.toThrow(/HTTP 429/);
    expect(get).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('throws on 401 and network errors instead of returning empty', async () => {
    get.mockRejectedValueOnce(httpError(401));
    await expect(
      newApi().getTopMedia({ mediaType: 'movie', days: 7, sort: 'plays' })
    ).rejects.toThrow(/HTTP 401/);

    get.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expect(
      newApi().getTopMedia({ mediaType: 'movie', days: 7, sort: 'plays' })
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('does not cache a failed request', async () => {
    const api = newApi();
    get.mockRejectedValueOnce(httpError(500));
    await expect(
      api.getTopMedia({ mediaType: 'movie', days: 7, sort: 'plays' })
    ).rejects.toThrow();

    get.mockResolvedValueOnce(page(movieFixture.data.slice(0, 2), null));
    const result = await api.getTopMedia({
      mediaType: 'movie',
      days: 7,
      sort: 'plays',
    });
    expect(result.rows).toHaveLength(2);
  });

  it('dedupes concurrent identical requests and caches by host, server, days and sort', async () => {
    get.mockResolvedValue(page(movieFixture.data.slice(0, 2), null));
    const api = newApi({ serverId: 'srv-a' });
    const base = { mediaType: 'movie' as const, days: 7 };

    await Promise.all([
      api.getTopMedia({ ...base, sort: 'plays' }),
      api.getTopMedia({ ...base, sort: 'plays' }),
    ]);
    expect(get).toHaveBeenCalledTimes(1);

    await api.getTopMedia({ ...base, sort: 'plays' });
    expect(get).toHaveBeenCalledTimes(1);

    await api.getTopMedia({ ...base, sort: 'viewers' });
    await api.getTopMedia({ ...base, days: 30, sort: 'plays' });
    expect(get).toHaveBeenCalledTimes(3);

    const sameHostOtherServer = new TracearrAPI(
      { hostname: 'x.test', apiKey: 'k', serverId: 'srv-1' },
      async () => undefined
    );
    const sameHostNoServer = new TracearrAPI(
      { hostname: 'x.test', apiKey: 'k' },
      async () => undefined
    );
    await sameHostOtherServer.getTopMedia({ ...base, sort: 'plays' });
    await sameHostNoServer.getTopMedia({ ...base, sort: 'plays' });
    expect(get).toHaveBeenCalledTimes(5);
  });

  it('reads the server list and version', async () => {
    get.mockResolvedValueOnce({ data: serversFixture });
    const result = await newApi().getServers();
    expect(result.version).toBe('v3.1.7');
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].server_type).toBe('plex');
  });
});

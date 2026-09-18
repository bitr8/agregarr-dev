import axios from 'axios';
import { chromium } from 'playwright';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ settings: undefined as unknown }));

// Fall back to real settings: TemplateEngine calls getSettings() at import time
vi.mock('@server/lib/settings', async (importOriginal) => {
  const actual = (await importOriginal()) as { getSettings: () => unknown };
  return {
    ...actual,
    getSettings: () => state.settings ?? actual.getSettings(),
  };
});

vi.mock('playwright', () => ({
  chromium: { launch: vi.fn() },
}));

vi.mock('axios', () => ({
  default: { post: vi.fn(), get: vi.fn() },
}));

import { CloudflareSolver } from './CloudflareSolver';

const mockPost = vi.mocked(axios.post);
const mockGet = vi.mocked(axios.get);
const mockLaunch = vi.mocked(chromium.launch);

const settingsWith = (solvers: { id: string; name: string; url: string }[]) =>
  ({ main: { cloudflareSolvers: solvers } } as unknown);

const solverOne = {
  id: 'a',
  name: 'FlareSolverr',
  url: 'http://solver-a:8191',
};
const solverTwo = { id: 'b', name: 'Byparr', url: 'http://solver-b:8191' };

const okResponse = (marker: string) => ({
  data: {
    status: 'ok',
    solution: {
      status: 200,
      response: `<html><title>Real Page</title><body>${marker}</body></html>`,
    },
  },
});

// Static backoff/cache state persists across tests — every test uses its own
// domain and URL so entries never collide
describe('CloudflareSolver failover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns first solver result without touching the second', async () => {
    state.settings = settingsWith([solverOne, solverTwo]);
    mockPost.mockResolvedValueOnce(okResponse('from-a'));

    const html = await CloudflareSolver.fetchPage('https://d1.example/page');

    expect(html).toContain('from-a');
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls[0][0]).toBe('http://solver-a:8191/v1');
  });

  it('hits the other solver first when priority is swapped', async () => {
    state.settings = settingsWith([solverTwo, solverOne]);
    mockPost.mockResolvedValueOnce(okResponse('from-b'));

    const html = await CloudflareSolver.fetchPage('https://d2.example/page');

    expect(html).toContain('from-b');
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls[0][0]).toBe('http://solver-b:8191/v1');
  });

  it('fails over to the next solver when the first errors', async () => {
    state.settings = settingsWith([solverOne, solverTwo]);
    mockPost
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(okResponse('from-b'));

    const html = await CloudflareSolver.fetchPage('https://d3.example/page');

    expect(html).toContain('from-b');
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockPost.mock.calls[0][0]).toBe('http://solver-a:8191/v1');
    expect(mockPost.mock.calls[1][0]).toBe('http://solver-b:8191/v1');
  });

  it('retries an instance after a single failure', async () => {
    state.settings = settingsWith([solverOne, solverTwo]);
    // First call: A fails once, B succeeds
    mockPost
      .mockRejectedValueOnce(new Error('timeout of 70000ms exceeded'))
      .mockResolvedValueOnce(okResponse('first'));
    await CloudflareSolver.fetchPage('https://d4.example/page1');

    // Second call, same domain: one failure is not a backoff, A gets another go
    mockPost.mockResolvedValueOnce(okResponse('second'));
    const html = await CloudflareSolver.fetchPage('https://d4.example/page2');

    expect(html).toContain('second');
    expect(mockPost).toHaveBeenCalledTimes(3);
    expect(mockPost.mock.calls[2][0]).toBe('http://solver-a:8191/v1');
  });

  it('skips an instance after two consecutive failures', async () => {
    state.settings = settingsWith([solverOne, solverTwo]);
    mockPost
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(okResponse('first'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(okResponse('second'));
    await CloudflareSolver.fetchPage('https://d10.example/page1');
    await CloudflareSolver.fetchPage('https://d10.example/page2');

    // Third call: A is now in backoff and must be skipped without a request
    mockPost.mockResolvedValueOnce(okResponse('third'));
    const html = await CloudflareSolver.fetchPage('https://d10.example/page3');

    expect(html).toContain('third');
    expect(mockPost).toHaveBeenCalledTimes(5);
    expect(mockPost.mock.calls[4][0]).toBe('http://solver-b:8191/v1');
  });

  it('throws naming every solver when all fail', async () => {
    state.settings = settingsWith([solverOne, solverTwo]);
    mockPost
      .mockRejectedValueOnce(new Error('boom-a'))
      .mockRejectedValueOnce(new Error('boom-b'));

    await expect(
      CloudflareSolver.fetchPage('https://d5.example/page')
    ).rejects.toThrow(/All 2 Cloudflare solver\(s\) failed.*boom-a.*boom-b/);
  });

  it('rejects a solver response that is still a challenge page', async () => {
    state.settings = settingsWith([solverOne]);
    mockPost.mockResolvedValueOnce({
      data: {
        status: 'ok',
        solution: {
          status: 200,
          response: '<html><title>Just a moment...</title></html>',
        },
      },
    });

    await expect(
      CloudflareSolver.fetchPage('https://d6.example/page')
    ).rejects.toThrow(/could not solve/);
  });

  it('surfaces the FlareSolverr reason on a 500 response', async () => {
    state.settings = settingsWith([solverOne]);
    mockPost.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 500'), {
        isAxiosError: true,
        response: {
          status: 500,
          data: {
            status: 'error',
            message:
              'Error: Error solving the challenge. Timeout after 60.0 seconds.',
          },
        },
      })
    );

    await expect(
      CloudflareSolver.fetchPage('https://d14.example/page')
    ).rejects.toThrow(
      /Error solving the challenge\. Timeout after 60\.0 seconds\./
    );
  });

  it('uses Playwright when no solvers are configured', async () => {
    state.settings = settingsWith([]);
    mockLaunch.mockRejectedValueOnce(new Error('no browser in tests'));

    await expect(
      CloudflareSolver.fetchPage('https://d7.example/page')
    ).rejects.toThrow();
    expect(mockLaunch).toHaveBeenCalledTimes(1);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('tolerates null entries in a hand-edited solver list', async () => {
    state.settings = {
      main: { cloudflareSolvers: [null, solverOne] },
    } as unknown;
    mockPost.mockResolvedValueOnce(okResponse('survived'));

    const html = await CloudflareSolver.fetchPage('https://d8.example/page');

    expect(html).toContain('survived');
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('serves cached pages from fetchPagesBatch while all solvers back off', async () => {
    state.settings = settingsWith([solverOne]);
    // Populate the cache, then drive the solver into backoff on another URL
    mockPost
      .mockResolvedValueOnce(okResponse('cached-page'))
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'));
    await CloudflareSolver.fetchPage('https://d9.example/cached');
    for (let i = 0; i < 2; i++) {
      await expect(
        CloudflareSolver.fetchPage('https://d9.example/uncached')
      ).rejects.toThrow();
    }

    const results = await CloudflareSolver.fetchPagesBatch([
      'https://d9.example/cached',
      'https://d9.example/uncached',
    ]);

    expect(results.get('https://d9.example/cached')).toContain('cached-page');
    expect(results.has('https://d9.example/uncached')).toBe(false);
    // Backoff skipped the uncached URL: no fourth request was made
    expect(mockPost).toHaveBeenCalledTimes(3);
  });

  it('forgets a failure older than the memory window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      state.settings = settingsWith([solverOne]);
      mockPost
        .mockRejectedValueOnce(new Error('down'))
        .mockRejectedValueOnce(new Error('down'))
        .mockResolvedValueOnce(okResponse('fresh'));
      await expect(
        CloudflareSolver.fetchPage('https://d12.example/p1')
      ).rejects.toThrow();
      vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000);
      await expect(
        CloudflareSolver.fetchPage('https://d12.example/p2')
      ).rejects.toThrow();

      // Six hours apart is not consecutive: still no backoff
      const html = await CloudflareSolver.fetchPage('https://d12.example/p3');

      expect(html).toContain('fresh');
      expect(mockPost).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps counting after an expired backoff when measured from its end', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      state.settings = settingsWith([solverOne]);
      // Six failures climb to the 16-minute cap, each retried just past expiry
      for (const backoffSecs of [0, 60, 120, 240, 480, 960]) {
        mockPost.mockRejectedValueOnce(new Error('down'));
        await expect(
          CloudflareSolver.fetchPage('https://d13.example/p')
        ).rejects.toThrow();
        vi.setSystemTime(Date.now() + (backoffSecs + 1) * 1000);
      }
      // 19 minutes after the last failure but 1 second past its backoff end
      vi.setSystemTime(Date.now() + 1100 * 1000);
      mockPost.mockRejectedValueOnce(new Error('down'));
      await expect(
        CloudflareSolver.fetchPage('https://d13.example/p')
      ).rejects.toThrow();

      // Still consecutive: seventh failure backs off, next call is skipped
      await expect(
        CloudflareSolver.fetchPage('https://d13.example/p')
      ).rejects.toThrow(/backing off/);
      expect(mockPost).toHaveBeenCalledTimes(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets the failure count on success', async () => {
    state.settings = settingsWith([solverOne]);
    mockPost
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(okResponse('recovered'))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(okResponse('still-trying'));
    await expect(
      CloudflareSolver.fetchPage('https://d11.example/p1')
    ).rejects.toThrow();
    await CloudflareSolver.fetchPage('https://d11.example/p2');
    await expect(
      CloudflareSolver.fetchPage('https://d11.example/p3')
    ).rejects.toThrow();

    // Fail, succeed, fail is one consecutive failure, not two: no backoff
    const html = await CloudflareSolver.fetchPage('https://d11.example/p4');

    expect(html).toContain('still-trying');
    expect(mockPost).toHaveBeenCalledTimes(4);
  });
});

describe('CloudflareSolver.fetchAsset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reuses the cookie/UA captured from a solve for a plain GET', async () => {
    state.settings = settingsWith([solverOne]);
    mockPost.mockResolvedValueOnce({
      data: {
        status: 'ok',
        solution: {
          status: 200,
          response: '<html><title>FlixPatrol</title></html>',
          cookies: [{ name: 'cf_clearance', value: 'abc' }],
          userAgent: 'UA-X',
        },
      },
    });
    mockGet.mockResolvedValueOnce({ data: 'body { color: red }' });

    await CloudflareSolver.fetchAsset(
      'https://flixpatrol.example/static/x.css'
    );

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet.mock.calls[0][0]).toBe(
      'https://flixpatrol.example/static/x.css'
    );
    expect(mockGet.mock.calls[0][1]?.headers).toMatchObject({
      Cookie: 'cf_clearance=abc',
      'User-Agent': 'UA-X',
    });
  });

  it('re-solves and retries with a fresh cookie when the asset GET 403s', async () => {
    state.settings = settingsWith([solverOne]);
    const solve = (cookieValue: string) => ({
      data: {
        status: 'ok',
        solution: {
          status: 200,
          response: '<html><title>FlixPatrol</title></html>',
          cookies: [{ name: 'cf_clearance', value: cookieValue }],
          userAgent: 'UA-X',
        },
      },
    });
    mockPost
      .mockResolvedValueOnce(solve('stale'))
      .mockResolvedValueOnce(solve('fresh'));
    mockGet
      .mockRejectedValueOnce(
        Object.assign(new Error('Request failed with status code 403'), {
          response: { status: 403 },
        })
      )
      .mockResolvedValueOnce({ data: 'body { color: red }' });

    await CloudflareSolver.fetchAsset('https://stale.example/static/x.css');

    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet.mock.calls[1][1]?.headers).toMatchObject({
      Cookie: 'cf_clearance=fresh',
    });
  });

  it('solves once, not per call, when the solver returns no cookies', async () => {
    state.settings = settingsWith([solverOne]);
    mockPost.mockResolvedValueOnce(okResponse('no-cookies'));
    mockGet.mockResolvedValue({ data: 'body { color: red }' });

    for (let i = 0; i < 3; i++) {
      await CloudflareSolver.fetchAsset(
        `https://cookieless.example/static/${i}.css`
      );
    }

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledTimes(3);
    expect(mockGet.mock.calls[2][1]?.headers?.Cookie).toBeUndefined();
  });

  it('does a plain GET with no Cookie header when no solvers are configured', async () => {
    state.settings = settingsWith([]);
    mockGet.mockResolvedValueOnce({ data: 'body { color: red }' });

    await CloudflareSolver.fetchAsset('https://noflare.example/static/x.css');

    expect(mockPost).not.toHaveBeenCalled();
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet.mock.calls[0][1]?.headers?.Cookie).toBeUndefined();
  });
});

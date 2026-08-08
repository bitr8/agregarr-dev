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

  it('skips an instance in backoff and goes straight to the next', async () => {
    state.settings = settingsWith([solverOne, solverTwo]);
    // First call: A fails (enters backoff), B succeeds
    mockPost
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(okResponse('first'));
    await CloudflareSolver.fetchPage('https://d4.example/page1');

    // Second call, same domain: A must be skipped without a request
    mockPost.mockResolvedValueOnce(okResponse('second'));
    const html = await CloudflareSolver.fetchPage('https://d4.example/page2');

    expect(html).toContain('second');
    expect(mockPost).toHaveBeenCalledTimes(3);
    expect(mockPost.mock.calls[2][0]).toBe('http://solver-b:8191/v1');
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
      .mockRejectedValueOnce(new Error('down'));
    await CloudflareSolver.fetchPage('https://d9.example/cached');
    await expect(
      CloudflareSolver.fetchPage('https://d9.example/uncached')
    ).rejects.toThrow();

    const results = await CloudflareSolver.fetchPagesBatch([
      'https://d9.example/cached',
      'https://d9.example/uncached',
    ]);

    expect(results.get('https://d9.example/cached')).toContain('cached-page');
    expect(results.has('https://d9.example/uncached')).toBe(false);
  });
});

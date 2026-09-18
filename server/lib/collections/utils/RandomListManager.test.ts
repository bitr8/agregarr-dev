import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ settings: undefined as unknown }));

// Fall back to real settings: RandomListManager calls getSettings() at module load time
vi.mock('@server/lib/settings', async (importOriginal) => {
  const actual = (await importOriginal()) as { getSettings: () => unknown };
  return {
    ...actual,
    getSettings: () => state.settings ?? actual.getSettings(),
  };
});

const fixtureHtml = fs.readFileSync(
  path.join(__dirname, '__fixtures__', 'letterboxd-lists-popular-root.html'),
  'utf-8'
);
const DISTINCT_LIST_COUNT = 18;

const fetchPage = vi.fn(async (url: string) => {
  if (url.includes('/page/')) {
    throw new Error('Request failed with status code 403');
  }
  return fixtureHtml;
});

vi.mock('@server/lib/collections/utils/LetterboxdHttpClient', () => ({
  LetterboxdHttpClient: { fetchPage: (url: string) => fetchPage(url) },
}));

const fetchPagesBatch = vi.fn(async (urls: string[], limit: number) => {
  void urls;
  void limit;
  return new Map<string, string>();
});

vi.mock('@server/lib/collections/utils/CloudflareSolver', () => ({
  CloudflareSolver: {
    fetchPagesBatch: (urls: string[], limit: number) =>
      fetchPagesBatch(urls, limit),
  },
}));

vi.mock('@server/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { RandomListManager } from './RandomListManager';

const manager = RandomListManager as unknown as {
  discoverLetterboxdLists(): Promise<string[]>;
};

describe('discoverLetterboxdLists (plain HTTP)', () => {
  it('fetches only the popular root, never a /page/ URL', async () => {
    state.settings = { main: { letterboxdUsePlainHttp: true } };
    fetchPage.mockClear();

    const result = await manager.discoverLetterboxdLists();

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(
      'https://letterboxd.com/lists/popular/'
    );
    expect(result).toHaveLength(DISTINCT_LIST_COUNT);
  });
});

describe('discoverLetterboxdLists (solver)', () => {
  it('keeps the random 3-page draw', async () => {
    state.settings = { main: { letterboxdUsePlainHttp: false } };
    fetchPagesBatch.mockClear();

    await manager.discoverLetterboxdLists();

    expect(fetchPagesBatch).toHaveBeenCalledTimes(1);
    const [urls] = fetchPagesBatch.mock.calls[0];
    expect(urls).toHaveLength(3);
    const nonRoot = urls.filter(
      (u: string) => u !== 'https://letterboxd.com/lists/popular/'
    );
    for (const u of nonRoot) {
      expect(u).toMatch(/\/lists\/popular\/page\/\d+\/$/);
    }
  });
});

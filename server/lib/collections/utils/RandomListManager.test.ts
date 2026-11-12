import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

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

import { normalizeListUrl, RandomListManager } from './RandomListManager';

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

describe('random list exclusions', () => {
  const pool = [
    'https://letterboxd.com/a/list/roulette/',
    'https://letterboxd.com/b/list/keep-me/',
    'https://letterboxd.com/c/list/also-kept/',
  ];
  const internals = RandomListManager as unknown as {
    configDir: string;
    getDiscoveredUrls(): Promise<string[]>;
    FALLBACK_LISTS: Record<string, string[]>;
  };
  const originalConfigDir = internals.configDir;
  afterEach(() => {
    internals.configDir = originalConfigDir;
    RandomListManager.clearCache();
  });

  const withConfig = async (content: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'random-lists-'));
    fs.writeFileSync(path.join(dir, 'letterboxd.txt'), content);
    internals.configDir = dir;
    RandomListManager.clearCache();
    vi.spyOn(internals, 'getDiscoveredUrls').mockResolvedValue([...pool]);
    try {
      return await RandomListManager.getRandomUrls('letterboxd', 'movie');
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('leaves the discovered pool untouched without exclude lines', async () => {
    const urls = await withConfig('enabled=false\nhttps://x.com/list/\n');
    expect(urls).toEqual(pool);
  });

  it('drops excluded lists whatever the slash, case, www or query', async () => {
    const urls = await withConfig(
      'enabled=false\nexclude=https://www.Letterboxd.com/a/list/roulette?sort=x\n'
    );
    expect(urls).toEqual(pool.slice(1));
  });

  it('falls back to the built-in lists when every discovered list is excluded', async () => {
    const urls = await withConfig(
      pool.map((u) => `EXCLUDE = ${u}`).join('\n') + '\n'
    );
    expect(urls).toEqual(internals.FALLBACK_LISTS.letterboxd);
  });

  it('returns nothing when discovered and built-in lists are all excluded', async () => {
    const urls = await withConfig(
      [...pool, ...internals.FALLBACK_LISTS.letterboxd]
        .map((u) => `exclude=${u}`)
        .join('\n') + '\n'
    );
    expect(urls).toEqual([]);
  });

  it('does not treat an exclude line as a configured list', async () => {
    const urls = await withConfig(`enabled=true\nexclude=${pool[0]}\n`);
    expect(urls).toEqual(pool.slice(1));
  });

  it('normalises list URLs for comparison', () => {
    expect(normalizeListUrl(' HTTP://www.imdb.com/list/ls123/#x ')).toBe(
      'imdb.com/list/ls123'
    );
  });

  it.each([
    [
      'https://www.themoviedb.org/collection/1570-alien-collection',
      'https://www.themoviedb.org/collection/1570',
    ],
    [
      'https://letterboxd.com/a/list/roulette/page/2/',
      'https://letterboxd.com/a/list/roulette/',
    ],
    [
      'https://letterboxd.com/a/list/roulette/by/rating/',
      'https://letterboxd.com/a/list/roulette/',
    ],
    [
      'https://app.trakt.tv/users/u/lists/x?sort=rank',
      'https://trakt.tv/users/u/lists/x',
    ],
    [
      'https://m.imdb.com/list/ls004285815/',
      'https://www.imdb.com/list/ls004285815/',
    ],
  ])('matches %s to %s', (copied, generated) => {
    expect(normalizeListUrl(copied)).toBe(normalizeListUrl(generated));
  });

  it('keeps distinct lists apart', () => {
    expect(
      normalizeListUrl('https://letterboxd.com/a/list/roulette/')
    ).not.toBe(normalizeListUrl('https://letterboxd.com/a/list/roulette-2/'));
    expect(
      normalizeListUrl('https://www.themoviedb.org/collection/15')
    ).not.toBe(normalizeListUrl('https://www.themoviedb.org/collection/1570'));
  });

  it('filters the TMDB library-backed pick too', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'random-lists-'));
    const excludedUrl = 'https://www.themoviedb.org/collection/1570';
    const keptUrl = 'https://www.themoviedb.org/collection/9485';
    fs.writeFileSync(
      path.join(dir, 'tmdb.txt'),
      `exclude=${excludedUrl}-alien-collection\n`
    );
    internals.configDir = dir;
    RandomListManager.clearCache();
    const tmdb = RandomListManager as unknown as {
      getDiscoveredUrls(): Promise<string[]>;
      getTmdbCollectionsFromLibrary(): Promise<string[]>;
    };
    vi.spyOn(tmdb, 'getDiscoveredUrls').mockResolvedValue([keptUrl]);
    vi.spyOn(tmdb, 'getTmdbCollectionsFromLibrary').mockResolvedValue([
      excludedUrl,
      keptUrl,
    ]);
    try {
      for (let i = 0; i < 10; i++) {
        const url = await RandomListManager.getRandomUrl(
          'tmdb',
          50,
          'movie',
          {} as never
        );
        expect(url).toBe(keptUrl);
      }
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still uses the library pool when every discovered and built-in TMDB collection is excluded', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'random-lists-'));
    const discovered = 'https://www.themoviedb.org/collection/1570';
    const libraryOnly = 'https://www.themoviedb.org/collection/424242';
    fs.writeFileSync(
      path.join(dir, 'tmdb.txt'),
      [discovered, ...internals.FALLBACK_LISTS.tmdb]
        .map((u) => `exclude=${u}`)
        .join('\n')
    );
    internals.configDir = dir;
    RandomListManager.clearCache();
    const tmdb = RandomListManager as unknown as {
      getDiscoveredUrls(): Promise<string[]>;
      getTmdbCollectionsFromLibrary(): Promise<string[]>;
    };
    vi.spyOn(tmdb, 'getDiscoveredUrls').mockResolvedValue([discovered]);
    vi.spyOn(tmdb, 'getTmdbCollectionsFromLibrary').mockResolvedValue([
      discovered,
      libraryOnly,
    ]);
    try {
      expect(
        await RandomListManager.getRandomUrl('tmdb', 50, 'movie', {} as never)
      ).toBe(libraryOnly);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

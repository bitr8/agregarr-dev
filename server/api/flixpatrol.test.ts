import fs from 'fs';
import { JSDOM } from 'jsdom';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    main: {},
    clientId: 'test',
  }),
}));

vi.mock('@server/lib/cache', () => ({
  default: {
    getCache: () => ({ data: undefined }),
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

import FlixPatrolAPI, { parsePlatformSubtype } from './flixpatrol';

describe('parsePlatformSubtype', () => {
  it.each([
    ['netflix_top_10', 'netflix', undefined],
    ['viki-tv_top_10', 'viki-tv', undefined],
    ['hbo-max_top_10', 'hbo-max', undefined],
    ['apple-tv_top_10', 'apple-tv', undefined],
    ['apple-tv-store_top_10', 'apple-tv-store', undefined],
    ['amazon-prime_top_10', 'amazon-prime', undefined],
    ['discovery-plus_top_10', 'discovery-plus', undefined],
    ['google-tv_top_10', 'google-tv', undefined],
    ['netflix-kids_top_10', 'netflix', 'kids'],
    ['amazon-prime-kids_top_10', 'amazon-prime', 'kids'],
  ])(
    '%s -> basePlatform=%s, contentFilter=%s',
    (input, expectedPlatform, expectedFilter) => {
      const { basePlatform, contentFilter } = parsePlatformSubtype(input);
      expect(basePlatform).toBe(expectedPlatform);
      expect(contentFilter).toBe(expectedFilter);
    }
  );
});

describe('FlixPatrolAPI', () => {
  describe('getAvailableCountries', () => {
    it('returns static country list with global first', async () => {
      const api = new FlixPatrolAPI();
      const countries = await api.getAvailableCountries();

      expect(countries[0]).toBe('global');
      expect(countries.length).toBeGreaterThan(100);
      expect(countries).toContain('australia');
      expect(countries).toContain('united-states');
      expect(countries).toContain('united-kingdom');
    });

    it('preserves FlixPatrol slug quirks', async () => {
      const api = new FlixPatrolAPI();
      const countries = await api.getAvailableCountries();

      expect(countries).toContain('salvador');
      expect(countries).not.toContain('el-salvador');
      expect(countries).toContain('swaziland');
      expect(countries).not.toContain('eswatini');
    });

    it('has no duplicates', async () => {
      const api = new FlixPatrolAPI();
      const countries = await api.getAvailableCountries();
      const unique = new Set(countries);

      expect(unique.size).toBe(countries.length);
    });

    it('countries are sorted (after global)', async () => {
      const api = new FlixPatrolAPI();
      const countries = await api.getAvailableCountries();
      const withoutGlobal = countries.slice(1);
      const sorted = [...withoutGlobal].sort();

      expect(withoutGlobal).toEqual(sorted);
    });
  });
});

describe('parseStreamingOverviewHtml', () => {
  const fixture = fs.readFileSync(
    path.join(__dirname, '__fixtures__', 'flixpatrol-us-apple-tv.html'),
    'utf8'
  );
  type ParsedLists = {
    tvShows: { title: string; flixpatrolUrl?: string }[];
    movies: { title: string }[];
  };
  const parse = (
    html: string,
    mediaType: 'movie' | 'tv',
    platform = 'apple-tv'
  ) =>
    (
      new FlixPatrolAPI() as unknown as {
        parseStreamingOverviewHtml: (
          html: string,
          platform: string,
          region: string,
          mediaType: 'movie' | 'tv'
        ) => Promise<ParsedLists>;
      }
    ).parseStreamingOverviewHtml(html, platform, 'united-states', mediaType);

  // Drop the "TOP 10 TV Shows" block, as on a day FlixPatrol has only
  // published the Amazon Channels chart so far.
  const withoutTvTable = (() => {
    const dom = new JSDOM(fixture);
    dom.window.document.querySelector('h2 + div')?.children[1].remove();
    return dom.serialize();
  })();

  it('reads the TV Shows table for a tv request', async () => {
    const result = await parse(fixture, 'tv');
    expect(result.tvShows.map((i) => i.title)).toEqual([
      'Ted Lasso',
      'Lucky',
      'Silo',
      'Trying',
      "Widow's Bay",
      'Shrinking',
      'Your Friends & Neighbors',
      'Sugar',
      'Cape Fear',
      'Severance',
    ]);
    expect(result.tvShows[2].flixpatrolUrl).toBe(
      'https://flixpatrol.com/title/silo-2023/'
    );
  });

  it('never substitutes the Amazon Channels table for a missing TV table', async () => {
    const result = await parse(withoutTvTable, 'tv');
    expect(result.tvShows).toEqual([]);
    expect(result.movies).toHaveLength(10);
  });

  it('ignores the channels table whatever the whitespace in its label', async () => {
    const nbspLabel = withoutTvTable.replace(
      'Overall (from Amazon Channels)',
      'Overall&nbsp;(from&nbsp;Amazon Channels)'
    );
    expect(nbspLabel).not.toBe(withoutTvTable);
    const result = await parse(nbspLabel, 'tv');
    expect(result.tvShows).toEqual([]);
  });

  it('keeps a platform whose only chart comes via Amazon Channels', async () => {
    const crunchyroll = fs.readFileSync(
      path.join(__dirname, '__fixtures__', 'flixpatrol-us-crunchyroll.html'),
      'utf8'
    );
    const result = await parse(crunchyroll, 'tv', 'crunchyroll');
    expect(result.tvShows).toHaveLength(10);
    expect(result.tvShows[0].title).toBe('Clevatess');
  });

  it('only reads the label, not titles, when spotting a channels table', async () => {
    const oddTitle = fixture.replace(
      /(<a\b[^>]*href="\/title\/the-dink\/"[^>]*>)\s*The Dink/,
      '$1News (From Local Channels)'
    );
    expect(oddTitle).not.toBe(fixture);
    const result = await parse(oddTitle, 'movie');
    expect(result.movies.map((i) => i.title)).toContain(
      'News (From Local Channels)'
    );
    expect(result.movies).toHaveLength(10);
  });

  it("keeps today's result when the previous-day fetch fails", async () => {
    const api = new FlixPatrolAPI();
    const fetchPage = vi
      .spyOn(
        api as unknown as { fetchFlixPatrolPage: () => Promise<string> },
        'fetchFlixPatrolPage'
      )
      .mockResolvedValueOnce(withoutTvTable)
      .mockRejectedValueOnce(new Error('503'));

    const result = await api.getPlatformTop10(
      'apple-tv_top_10',
      'united-states',
      'tv'
    );

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.tvShows).toEqual([]);
    expect(result.movies).toHaveLength(10);
  });

  it('falls back to the previous day when today has no TV table yet', async () => {
    const api = new FlixPatrolAPI();
    const fetchPage = vi
      .spyOn(
        api as unknown as { fetchFlixPatrolPage: () => Promise<string> },
        'fetchFlixPatrolPage'
      )
      .mockResolvedValueOnce(withoutTvTable)
      .mockResolvedValueOnce(fixture);

    const result = await api.getPlatformTop10(
      'apple-tv_top_10',
      'united-states',
      'tv'
    );

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.tvShows.map((i) => i.title)).toContain('Severance');
    expect(result.tvShows.map((i) => i.flixpatrolUrl)).not.toContain(
      'https://flixpatrol.com/title/silo/'
    );
  });
});

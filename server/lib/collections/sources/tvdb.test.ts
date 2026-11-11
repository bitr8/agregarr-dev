import type PlexAPI from '@server/api/plexapi';
import type { TvdbListExtended } from '@server/api/tvdb/interfaces';
import type { CollectionConfig } from '@server/lib/settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getList, getEntityInfo } = vi.hoisted(() => ({
  getList: vi.fn(),
  getEntityInfo: vi.fn(),
}));

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/api/imdbRatings', () => ({ default: class {} }));
vi.mock('@server/lib/cache', () => ({ default: { getCache: vi.fn() } }));
vi.mock('@server/lib/posterStorage', () => ({ generatePoster: vi.fn() }));
vi.mock('@server/lib/collections/services/ServiceUserManager', () => ({
  serviceUserManager: {},
}));
vi.mock('@server/lib/collections/utils/TemplateEngine', () => ({
  templateEngine: {},
}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    plex: {
      collectionConfigs: [],
      libraries: [
        { key: '1', type: 'movie' },
        { key: '2', type: 'show' },
      ],
    },
    save: vi.fn(),
  }),
}));
vi.mock('@server/api/tvdb', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    default: class {
      getList = getList;
      getEntityInfo = getEntityInfo;
    },
  };
});
vi.mock('@server/lib/collections/core/CollectionUtilities', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  findPlexItemsByTmdbIds: vi.fn(),
}));

import { findPlexItemsByTmdbIds } from '@server/lib/collections/core/CollectionUtilities';
import logger from '@server/logger';
import { TvdbCollectionSync } from './tvdb';

const mixedList: TvdbListExtended = {
  id: 9001,
  name: 'Sample Franchise',
  url: 'sample-franchise',
  isOfficial: true,
  entities: [
    { order: 3, seriesId: 5003, movieId: null },
    { order: 1, seriesId: null, movieId: 1001 },
    { order: 2, seriesId: null, movieId: 1002 },
    { order: 4, seriesId: 5004, movieId: null },
  ],
};

const infoById: Record<string, unknown> = {
  '1001': { tmdbId: 7001, name: 'First Film', year: 1999 },
  '1002': { tmdbId: undefined, name: 'No Mapping', year: 2001 },
  '5003': { tmdbId: 8003, name: 'Spinoff Show', year: 2010 },
  '5004': { tmdbId: 8004, name: 'Other Show', year: 2012 },
};

const cfg = (libraryId: string): CollectionConfig =>
  ({
    id: 'c1',
    name: 'TVDB Test',
    type: 'tvdb',
    subtype: 'custom',
    libraryId,
    isActive: true,
    tvdbCustomListUrl: 'https://thetvdb.com/lists/sample-franchise',
  } as unknown as CollectionConfig);

describe('TvdbCollectionSync', () => {
  beforeEach(() => {
    getList.mockReset().mockResolvedValue(mixedList);
    getEntityInfo
      .mockReset()
      .mockImplementation(async (_kind: string, id: number) => {
        return infoById[String(id)];
      });
  });

  it('looks the list up by slug and keeps only movies for a movie library, in list order', async () => {
    const data = await new TvdbCollectionSync().fetchSourceData(cfg('1'));

    expect(getList).toHaveBeenCalledWith({ slug: 'sample-franchise' });
    expect(data.map((d) => [d.tvdbId, d.tmdbId, d.position])).toEqual([
      [1001, 7001, 1],
      [1002, undefined, 2],
    ]);
    expect(data.every((d) => d.mediaType === 'movie')).toBe(true);
  });

  it('keeps only series for a show library', async () => {
    const data = await new TvdbCollectionSync().fetchSourceData(cfg('2'));

    expect(getEntityInfo).not.toHaveBeenCalledWith('movie', expect.anything());
    expect(data.map((d) => [d.tvdbId, d.tmdbId])).toEqual([
      [5003, 8003],
      [5004, 8004],
    ]);
  });

  it('aborts the sync when any lookup fails, naming the failed ids', async () => {
    getEntityInfo.mockImplementation(async (_kind: string, id: number) => {
      if (id === 5004) throw new Error('boom');
      return infoById[String(id)];
    });
    await expect(
      new TvdbCollectionSync().fetchSourceData(cfg('2'))
    ).rejects.toThrow(/Failed to fetch data from TVDB/);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.stringContaining('aborting'),
      expect.objectContaining({ failedIds: [5004] })
    );
  });

  it('retries once on a 429 and then succeeds', async () => {
    vi.useFakeTimers();
    let calls = 0;
    getEntityInfo.mockImplementation(async (_kind: string, id: number) => {
      if (id === 5003 && calls++ === 0)
        throw Object.assign(new Error('rate'), { response: { status: 429 } });
      return infoById[String(id)];
    });
    const pending = new TvdbCollectionSync().fetchSourceData(cfg('2'));
    await vi.runAllTimersAsync();
    const data = await pending;
    vi.useRealTimers();
    expect(calls).toBe(2);
    expect(data.map((d) => d.tmdbId)).toEqual([8003, 8004]);
  });

  it('skips a 404 entry without retrying or aborting', async () => {
    getEntityInfo.mockImplementation(async (_kind: string, id: number) => {
      if (id === 5004)
        throw Object.assign(new Error('nf'), { response: { status: 404 } });
      return infoById[String(id)];
    });
    const data = await new TvdbCollectionSync().fetchSourceData(cfg('2'));
    expect(data.map((d) => d.tmdbId)).toEqual([8003]);
    expect(getEntityInfo).toHaveBeenCalledTimes(2);
  });

  it('aborts when every entry is not found', async () => {
    getEntityInfo.mockRejectedValue(
      Object.assign(new Error('nf'), { response: { status: 404 } })
    );
    await expect(
      new TvdbCollectionSync().fetchSourceData(cfg('2'))
    ).rejects.toThrow(/Failed to fetch data from TVDB/);
  });

  it('fails when the list itself is not found', async () => {
    getList.mockRejectedValueOnce(
      Object.assign(new Error('nf'), { response: { status: 404 } })
    );
    await expect(
      new TvdbCollectionSync().fetchSourceData(cfg('2'))
    ).rejects.toThrow(/Failed to fetch data from TVDB/);
  });

  it('rejects a config whose URL is not a TVDB list', async () => {
    await expect(
      new TvdbCollectionSync().fetchSourceData({
        ...cfg('1'),
        tvdbCustomListUrl: 'https://thetvdb.com/series/some-show',
      } as unknown as CollectionConfig)
    ).rejects.toThrow(/valid TVDB list URL/);
  });

  it('maps library hits to items and the rest to missing items carrying title, year and tvdbId', async () => {
    const sync = new TvdbCollectionSync();
    const data = await sync.fetchSourceData(cfg('2'));
    vi.mocked(findPlexItemsByTmdbIds).mockResolvedValue(
      new Map([
        [
          '8003-tv',
          {
            ratingKey: 'rk-1',
            title: 'Spinoff Show',
            libraryKey: '2',
          },
        ],
      ]) as never
    );

    const result = await sync.mapSourceDataToItems(
      data,
      cfg('2'),
      {} as PlexAPI
    );

    expect(result.items.map((i) => i.ratingKey)).toEqual(['rk-1']);
    expect(result.missingItems).toEqual([
      expect.objectContaining({
        tmdbId: 8004,
        tvdbId: 5004,
        title: 'Other Show',
        year: 2012,
        mediaType: 'tv',
        originalPosition: 2,
        source: 'tvdb',
      }),
    ]);
  });

  it('drops entities TVDB has no TMDB mapping for and counts them as invalid', async () => {
    const sync = new TvdbCollectionSync();
    const data = await sync.fetchSourceData(cfg('1'));
    vi.mocked(findPlexItemsByTmdbIds).mockResolvedValue(new Map());

    const result = await sync.mapSourceDataToItems(
      data,
      cfg('1'),
      {} as PlexAPI
    );

    expect(result.missingItems?.map((m) => m.tmdbId)).toEqual([7001]);
  });
});

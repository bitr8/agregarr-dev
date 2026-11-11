import type PlexAPI from '@server/api/plexapi';
import movieFixture from '@server/api/__fixtures__/tracearr-top-media-movie-365.json';
import showFixture from '@server/api/__fixtures__/tracearr-top-media-show-365.json';
import type { CollectionConfig } from '@server/lib/settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTopMedia: vi.fn(),
  getMedia: vi.fn(),
  getByExternalId: vi.fn(),
  findPlexItemsByTmdbIds: vi.fn(),
}));

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/entity/CollectionMetadata', () => ({
  CollectionMetadata: class {},
}));
vi.mock('@server/entity/CollectionMissingItems', () => ({
  CollectionMissingItems: class {},
}));
vi.mock('@server/entity/PosterTemplate', () => ({ PosterTemplate: class {} }));
vi.mock('@server/entity/User', () => ({ User: class {} }));
vi.mock('@server/api/imdbRatings', () => ({ default: class {} }));
vi.mock('@server/lib/cache', () => ({ default: { getCache: vi.fn() } }));
vi.mock('@server/lib/posterStorage', () => ({ generatePoster: vi.fn() }));
vi.mock('@server/lib/collections/services/ServiceUserManager', () => ({
  serviceUserManager: {},
}));
vi.mock('@server/lib/collections/utils/TemplateEngine', () => ({
  templateEngine: { processTemplate: (t: string) => t },
}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/api/themoviedb', () => ({
  default: class {
    getByExternalId = mocks.getByExternalId;
  },
}));
vi.mock('@server/api/tracearr', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@server/api/tracearr')),
  default: class {
    getTopMedia = mocks.getTopMedia;
    getMedia = mocks.getMedia;
  },
}));
vi.mock('@server/lib/collections/core/CollectionUtilities', async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    '@server/lib/collections/core/CollectionUtilities'
  )),
  findPlexItemsByTmdbIds: mocks.findPlexItemsByTmdbIds,
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    globalExclusions: { movies: [], tv: [], tvdb: [] },
    tracearr: {
      enabled: true,
      hostname: 'tracearr.example',
      port: 3000,
      apiKey: 'k',
      serverId: 'srv-1',
    },
    plex: {
      collectionConfigs: [],
      libraries: [
        { key: '4', name: 'Movies', type: 'movie' },
        { key: '5', name: 'Shows', type: 'show' },
      ],
    },
  }),
}));

import { TracearrHttpError } from '@server/api/tracearr';
import { TautulliCollectionSync } from './tautulli';
import { TracearrStatsCollectionSync } from './tracearrStats';

const config = (overrides: Record<string, unknown> = {}) =>
  ({
    id: '1',
    name: 'Stats',
    type: 'tautulli',
    subtype: 'most_watched_plays',
    libraryId: '4',
    customDays: 30,
    minimumPlays: 2,
    ...overrides,
  } as unknown as CollectionConfig);

const topMediaResult = (rows: unknown[]) => ({ rows, truncated: false });

const plexHit = (ratingKey: string, title: string) => ({
  ratingKey,
  title,
  libraryKey: '4',
  addedAt: 1,
});

describe('TracearrStatsCollectionSync.fetchSourceData', () => {
  beforeEach(() => {
    mocks.getTopMedia.mockReset();
    mocks.getMedia.mockReset();
    mocks.getByExternalId.mockReset();
    mocks.findPlexItemsByTmdbIds.mockReset();
  });

  it.each([
    ['most_watched_plays', '4', 'plays', 'movie'],
    ['most_watched_duration', '4', 'watch_time', 'movie'],
    ['most_popular_plays', '5', 'viewers', 'show'],
    ['most_popular_duration', '5', 'viewers', 'show'],
  ])('maps %s to sort=%s', async (subtype, libraryId, sort, mediaType) => {
    mocks.getTopMedia.mockResolvedValue(topMediaResult([]));
    await new TracearrStatsCollectionSync().fetchSourceData(
      config({ subtype, libraryId })
    );
    expect(mocks.getTopMedia).toHaveBeenCalledWith(
      expect.objectContaining({ sort, mediaType, days: 30 })
    );
  });

  it('clamps days to 365', async () => {
    mocks.getTopMedia.mockResolvedValue(topMediaResult([]));
    await new TracearrStatsCollectionSync().fetchSourceData(
      config({ customDays: 9999 })
    );
    expect(mocks.getTopMedia.mock.calls[0][0].days).toBe(365);
  });

  it('converts watch_time_ms to seconds and uses unique_users as viewers', async () => {
    mocks.getTopMedia.mockResolvedValue(
      topMediaResult(movieFixture.data.slice(0, 2))
    );
    const rows = await new TracearrStatsCollectionSync().fetchSourceData(
      config()
    );
    expect(rows[0]).toMatchObject({
      title: 'Moana',
      tmdb_id: 277834,
      total_plays: 13,
      users_watched: 1,
      duration: 71824,
    });
  });

  it('re-sorts popular rows by viewers, then plays, then recency', async () => {
    const row = (title: string, users: number, plays: number, day: string) => ({
      ...movieFixture.data[0],
      title,
      unique_users: users,
      plays,
      watch_time_ms: plays * 1000,
      last_watched_day: day,
    });
    mocks.getTopMedia.mockResolvedValue(
      topMediaResult([
        row('c', 2, 5, '2026-01-01'),
        row('a', 3, 1, '2026-01-01'),
        row('b', 2, 9, '2026-01-01'),
        row('d', 2, 5, '2026-02-01'),
      ])
    );
    const rows = await new TracearrStatsCollectionSync().fetchSourceData(
      config({ subtype: 'most_popular_plays' })
    );
    expect(rows.map((r) => r.title)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('passes minimumPlays as the viewer floor for popular only', async () => {
    mocks.getTopMedia.mockResolvedValue(topMediaResult([]));
    await new TracearrStatsCollectionSync().fetchSourceData(
      config({ subtype: 'most_popular_plays', minimumPlays: 3 })
    );
    expect(mocks.getTopMedia.mock.calls[0][0].minViewers).toBe(3);

    mocks.getTopMedia.mockClear();
    await new TracearrStatsCollectionSync().fetchSourceData(config());
    expect(mocks.getTopMedia.mock.calls[0][0].minViewers).toBeUndefined();
  });

  it('bypasses the client cache only for an explicit refresh', async () => {
    mocks.getTopMedia.mockResolvedValue(topMediaResult([]));
    const sync = new TracearrStatsCollectionSync();
    await sync.fetchSourceData(config(), { useCache: false });
    await sync.fetchSourceData(config(), { useCache: true });
    await sync.fetchSourceData(config());
    expect(
      mocks.getTopMedia.mock.calls.map((call) => call[0].bypassCache)
    ).toEqual([true, false, false]);
  });

  it('propagates Tracearr failures instead of returning an empty list', async () => {
    mocks.getTopMedia.mockRejectedValue(new Error('[Tracearr] down'));
    await expect(
      new TracearrStatsCollectionSync().fetchSourceData(config())
    ).rejects.toThrow('down');
  });
});

describe('TracearrStatsCollectionSync.mapSourceDataToItems', () => {
  const plex = { getMetadata: vi.fn() } as unknown as PlexAPI;

  beforeEach(() => {
    mocks.getMedia.mockReset();
    mocks.getByExternalId.mockReset();
    mocks.findPlexItemsByTmdbIds.mockReset();
    mocks.getMedia.mockResolvedValue({ availability: [] });
    (plex.getMetadata as ReturnType<typeof vi.fn>).mockReset();
  });

  const toSource = (row: (typeof movieFixture.data)[number]) => ({
    title: row.title,
    media_type: row.media_type,
    year: row.year,
    tmdb_id: row.tmdb_id ?? undefined,
    tvdb_id: row.tvdb_id ?? undefined,
    imdb_id: row.imdb_id ?? undefined,
    tracearr_media_id: row.media_id,
    total_plays: row.plays,
    users_watched: row.unique_users,
  });

  it('resolves rows through findPlexItemsByTmdbIds in source order', async () => {
    const rows = movieFixture.data.slice(0, 3).map(toSource);
    mocks.findPlexItemsByTmdbIds.mockResolvedValue(
      new Map([
        [`${rows[2].tmdb_id}-movie`, plexHit('300', rows[2].title as string)],
        [`${rows[0].tmdb_id}-movie`, plexHit('100', rows[0].title as string)],
      ])
    );

    const result = await new TracearrStatsCollectionSync().mapSourceDataToItems(
      rows,
      config({ minimumPlays: 1 }),
      plex
    );

    expect(result.items.map((i) => i.ratingKey)).toEqual(['100', '300']);
    expect(result.items[0]).toMatchObject({
      type: 'movie',
      tmdbId: rows[0].tmdb_id,
      totalPlays: rows[0].total_plays,
    });
    expect(result.items[0].metadata?.originalPosition).toBe(1);
    expect(result.items[1].metadata?.originalPosition).toBe(3);
    expect(mocks.findPlexItemsByTmdbIds.mock.calls[0][2]).toBe('4');
  });

  it('applies minimumPlays to unique viewers for popular, not for watched', async () => {
    const rows = movieFixture.data.slice(0, 4).map(toSource);
    const hits = new Map(
      rows.map((r, i) => [`${r.tmdb_id}-movie`, plexHit(String(i), r.title)])
    );
    mocks.findPlexItemsByTmdbIds.mockResolvedValue(hits);
    const viewers = rows.map((r) => r.users_watched);
    const eligible = viewers.filter((v) => v >= 2).length;
    expect(eligible).toBeGreaterThan(0);
    expect(eligible).toBeLessThan(rows.length);

    const popular =
      await new TracearrStatsCollectionSync().mapSourceDataToItems(
        rows,
        config({ subtype: 'most_popular_plays', minimumPlays: 2 }),
        plex
      );
    const watched =
      await new TracearrStatsCollectionSync().mapSourceDataToItems(
        rows,
        config({ subtype: 'most_watched_plays', minimumPlays: 2 }),
        plex
      );
    expect(popular.items).toHaveLength(eligible);
    expect(watched.items).toHaveLength(rows.length);
  });

  it('drops rows of the wrong media type', async () => {
    const rows = showFixture.data.slice(0, 2).map(toSource);
    const result = await new TracearrStatsCollectionSync().mapSourceDataToItems(
      rows,
      config({ minimumPlays: 1 }),
      plex
    );
    expect(result.items).toEqual([]);
    expect(mocks.findPlexItemsByTmdbIds).not.toHaveBeenCalled();
  });

  describe('shows without a tmdb id', () => {
    const noTmdb = {
      title: 'Obscure Show',
      media_type: 'show',
      year: 2020,
      tvdb_id: 555,
      tracearr_media_id: 'media-1',
      total_plays: 4,
      users_watched: 2,
    };
    const showConfig = config({ libraryId: '5', minimumPlays: 1 });

    it('falls back to a TMDB lookup by tvdb id', async () => {
      mocks.getByExternalId.mockResolvedValue({ tv_results: [{ id: 9001 }] });
      mocks.findPlexItemsByTmdbIds.mockResolvedValue(
        new Map([['9001-tv', plexHit('900', 'Obscure Show')]])
      );

      const result =
        await new TracearrStatsCollectionSync().mapSourceDataToItems(
          [noTmdb],
          showConfig,
          plex
        );

      expect(mocks.getByExternalId).toHaveBeenCalledWith({
        externalId: 555,
        type: 'tvdb',
      });
      expect(result.items.map((i) => [i.ratingKey, i.tmdbId])).toEqual([
        ['900', 9001],
      ]);
    });

    it('accepts an availability rating key only when title and year match', async () => {
      mocks.getByExternalId.mockResolvedValue({ tv_results: [] });
      mocks.findPlexItemsByTmdbIds.mockResolvedValue(new Map());
      mocks.getMedia.mockResolvedValue({
        availability: [
          { server_id: 'srv-1', server_type: 'plex', rating_key: '77' },
        ],
      });
      (plex.getMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
        ratingKey: '77',
        title: 'obscure show',
        year: 2020,
        librarySectionID: 5,
        Guid: [{ id: 'tvdb://555' }],
      });

      const ok = await new TracearrStatsCollectionSync().mapSourceDataToItems(
        [noTmdb],
        showConfig,
        plex
      );
      expect(ok.items.map((i) => i.ratingKey)).toEqual(['77']);

      (plex.getMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
        ratingKey: '77',
        title: 'A Different Show',
        year: 2020,
        librarySectionID: 5,
        Guid: [],
      });
      const wrongTitle =
        await new TracearrStatsCollectionSync().mapSourceDataToItems(
          [noTmdb],
          showConfig,
          plex
        );
      expect(wrongTitle.items).toEqual([]);

      (plex.getMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
        ratingKey: '77',
        title: 'Obscure Show',
        year: 1999,
        librarySectionID: 5,
        Guid: [],
      });
      const wrongYear =
        await new TracearrStatsCollectionSync().mapSourceDataToItems(
          [noTmdb],
          showConfig,
          plex
        );
      expect(wrongYear.items).toEqual([]);
    });

    it('ignores availability entries from other servers', async () => {
      mocks.getByExternalId.mockResolvedValue({ tv_results: [] });
      mocks.findPlexItemsByTmdbIds.mockResolvedValue(new Map());
      mocks.getMedia.mockResolvedValue({
        availability: [
          { server_id: 'srv-other', server_type: 'plex', rating_key: '77' },
        ],
      });
      const result =
        await new TracearrStatsCollectionSync().mapSourceDataToItems(
          [noTmdb],
          showConfig,
          plex
        );
      expect(result.items).toEqual([]);
      expect(plex.getMetadata).not.toHaveBeenCalled();
    });

    const availabilityEntry = (ratingKey: string, extra = {}) => ({
      server_id: 'srv-1',
      server_type: 'plex',
      rating_key: ratingKey,
      removed_at: null,
      ...extra,
    });
    const plexMeta = {
      ratingKey: '77',
      title: 'Obscure Show',
      year: 2020,
      librarySectionID: 5,
      Guid: [],
    };
    const run = (rows: unknown[]) =>
      new TracearrStatsCollectionSync().mapSourceDataToItems(
        rows as never,
        showConfig,
        plex
      );

    it('aborts when the media lookup fails with auth, network or 5xx errors', async () => {
      mocks.getByExternalId.mockResolvedValue({ tv_results: [] });
      mocks.findPlexItemsByTmdbIds.mockResolvedValue(new Map());
      for (const error of [
        new TracearrHttpError(401, '[Tracearr] 401'),
        new TracearrHttpError(503, '[Tracearr] 503'),
        new Error('connect ECONNREFUSED'),
      ]) {
        mocks.getMedia.mockRejectedValueOnce(error);
        await expect(run([noTmdb])).rejects.toThrow(error.message);
      }
    });

    it('treats a 404 media lookup as not found', async () => {
      mocks.getByExternalId.mockResolvedValue({ tv_results: [] });
      mocks.findPlexItemsByTmdbIds.mockResolvedValue(new Map());
      mocks.getMedia.mockRejectedValue(new TracearrHttpError(404, 'gone'));
      expect((await run([noTmdb])).items).toEqual([]);
    });

    it('skips an entry Plex does not have and tries the next one', async () => {
      mocks.getByExternalId.mockResolvedValue({ tv_results: [] });
      mocks.findPlexItemsByTmdbIds.mockResolvedValue(new Map());
      mocks.getMedia.mockResolvedValue({
        availability: [availabilityEntry('11'), availabilityEntry('77')],
      });
      (plex.getMetadata as ReturnType<typeof vi.fn>).mockImplementation(
        async (key: string) => {
          if (key === '11') {
            throw new Error(
              'Plex Server didnt respond with a valid 2xx status code, response code: 404'
            );
          }
          return plexMeta;
        }
      );
      expect((await run([noTmdb])).items.map((i) => i.ratingKey)).toEqual([
        '77',
      ]);
    });

    it('propagates non-404 Plex errors from the availability lookup', async () => {
      mocks.getByExternalId.mockResolvedValue({ tv_results: [] });
      mocks.findPlexItemsByTmdbIds.mockResolvedValue(new Map());
      mocks.getMedia.mockResolvedValue({
        availability: [availabilityEntry('11')],
      });
      (plex.getMetadata as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error(
          'Plex Server didnt respond with a valid 2xx status code, response code: 500'
        )
      );
      await expect(run([noTmdb])).rejects.toThrow('500');
    });

    it('ignores entries that Tracearr marks as removed', async () => {
      mocks.getByExternalId.mockResolvedValue({ tv_results: [] });
      mocks.findPlexItemsByTmdbIds.mockResolvedValue(new Map());
      mocks.getMedia.mockResolvedValue({
        availability: [
          availabilityEntry('77', { removed_at: '2025-01-01T00:00:00Z' }),
        ],
      });
      expect((await run([noTmdb])).items).toEqual([]);
      expect(plex.getMetadata).not.toHaveBeenCalled();
    });

    it('also tries the availability lookup for rows that have a tmdb id but missed the library', async () => {
      mocks.findPlexItemsByTmdbIds.mockResolvedValue(new Map());
      mocks.getMedia.mockResolvedValue({
        availability: [availabilityEntry('77')],
      });
      (plex.getMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(
        plexMeta
      );
      const withTmdb = { ...noTmdb, tmdb_id: 4242 };
      const result = await run([withTmdb]);
      expect(mocks.getMedia).toHaveBeenCalledWith('media-1');
      expect(result.items.map((i) => [i.ratingKey, i.tmdbId])).toEqual([
        ['77', 4242],
      ]);
    });
  });
});

describe('Tracearr cache key', () => {
  it('differs from the Tautulli key and carries host, server and stat type', () => {
    const key = (sync: object) =>
      (
        sync as unknown as { generateCacheKey(c: CollectionConfig): string }
      ).generateCacheKey(config());
    const tracearrKey = key(new TracearrStatsCollectionSync());
    expect(tracearrKey).toContain('tracearr:tracearr.example:3000:srv-1');
    expect(tracearrKey).not.toBe(key(new TautulliCollectionSync()));
    expect(tracearrKey).toContain('plays');
  });
});

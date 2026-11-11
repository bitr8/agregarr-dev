import movieFixture from '@server/api/__fixtures__/tracearr-top-media-movie-365.json';
import showFixture from '@server/api/__fixtures__/tracearr-top-media-show-365.json';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTopMedia: vi.fn(),
  failingKey: '',
  collections: {} as Record<
    string,
    { title: string; children: { type: string; Guid: { id: string }[] }[] }
  >,
}));

vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({ tracearr: { hostname: 'tracearr.example' }, plex: {} }),
}));
vi.mock('@server/api/plexapi', () => ({
  default: class {
    getCollectionMetadataSafe = async (key: string) => {
      const c = mocks.collections[key];
      return c
        ? { title: c.title, librarySectionID: 4, librarySectionTitle: 'Movies' }
        : null;
    };
    getCollectionItemsWithMetadata = async (key: string) => {
      if (key === mocks.failingKey) throw new Error('plex children failed');
      return mocks.collections[key]?.children ?? [];
    };
  },
}));
vi.mock('@server/api/tracearr', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@server/api/tracearr')),
  default: class {
    getTopMedia = mocks.getTopMedia;
  },
}));
vi.mock('@server/lib/collections/core/CollectionUtilities', async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    '@server/lib/collections/core/CollectionUtilities'
  )),
  getAdminUser: async () => ({ plexToken: 'token' }),
}));
vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/entity/User', () => ({ User: class {} }));

import {
  getTracearrCollectionStats,
  getTracearrDashboardInputs,
} from './tracearrDashboard';

const moana = movieFixture.data[0];
const second = movieFixture.data[1];
const office = showFixture.data[0];

describe('Tracearr dashboard collection stats', () => {
  beforeEach(() => {
    mocks.getTopMedia.mockReset();
    mocks.getTopMedia.mockImplementation(
      async ({ mediaType }: { mediaType: string }) => ({
        rows: mediaType === 'movie' ? movieFixture.data : showFixture.data,
        truncated: false,
      })
    );
    mocks.collections = {
      '10': {
        title: 'Family',
        children: [
          { type: 'movie', Guid: [{ id: `tmdb://${moana.tmdb_id}` }] },
          { type: 'movie', Guid: [{ id: 'tmdb://1' }] },
        ],
      },
      '11': {
        title: 'Sitcoms',
        children: [
          { type: 'show', Guid: [{ id: `tvdb://${office.tvdb_id}` }] },
          { type: 'movie', Guid: [{ id: `tmdb://${second.tmdb_id}` }] },
        ],
      },
      '12': {
        title: 'Never Watched',
        children: [{ type: 'movie', Guid: [{ id: 'tmdb://2' }] }],
      },
    };
  });

  it('sums member plays and watch time, drops zero-play collections', async () => {
    const stats = await getTracearrCollectionStats({
      limit: 10,
      statType: 'plays',
      days: 30,
      collectionRatingKeys: ['10', '11', '12', '99'],
    });

    expect(stats.map((s) => [s.title, s.total_plays])).toEqual([
      ['Sitcoms', office.plays + second.plays],
      ['Family', moana.plays],
    ]);
    const family = stats.find((s) => s.title === 'Family');
    expect(family).toMatchObject({
      rating_key: '10',
      item_count: 2,
      total_duration: Math.round(moana.watch_time_ms / 1000),
      section_name: 'Movies',
      user_stats: [],
    });
  });

  it('sorts by duration and applies the limit', async () => {
    const stats = await getTracearrCollectionStats({
      limit: 1,
      statType: 'duration',
      days: 30,
      collectionRatingKeys: ['10', '11'],
    });
    const byDuration = [
      ['10', moana.watch_time_ms],
      ['11', office.watch_time_ms + second.watch_time_ms],
    ].sort((a, b) => Number(b[1]) - Number(a[1]));
    expect(stats.map((s) => s.rating_key)).toEqual([byDuration[0][0]]);
  });

  it('clamps days to 365 and returns nothing without collections', async () => {
    await getTracearrCollectionStats({
      limit: 5,
      statType: 'plays',
      days: 9999,
      collectionRatingKeys: ['10'],
    });
    expect(mocks.getTopMedia.mock.calls[0][0].days).toBe(365);

    mocks.getTopMedia.mockClear();
    expect(
      await getTracearrCollectionStats({
        limit: 5,
        statType: 'plays',
        days: 30,
        collectionRatingKeys: [],
      })
    ).toEqual([]);
    expect(mocks.getTopMedia).not.toHaveBeenCalled();
  });

  it('builds the weekly inputs from the top ten per media type', async () => {
    const [collections, movies, shows] = await getTracearrDashboardInputs([
      '10',
    ]);
    expect(movies).toHaveLength(10);
    expect(movies[0]).toEqual({ total_plays: moana.plays });
    expect(shows[0]).toEqual({ total_plays: office.plays });
    expect(collections.map((c) => c.rating_key)).toEqual(['10']);
  });

  it('skips a collection whose members cannot be read instead of failing the map', async () => {
    mocks.collections['13'] = {
      title: 'Broken',
      children: [{ type: 'movie', Guid: [{ id: `tmdb://${moana.tmdb_id}` }] }],
    };
    mocks.failingKey = '13';
    const stats = await getTracearrCollectionStats({
      limit: 10,
      statType: 'plays',
      days: 30,
      collectionRatingKeys: ['13', '10'],
    });
    mocks.failingKey = '';
    expect(stats.map((s) => s.rating_key)).toEqual(['10']);
  });

  it('propagates Tracearr failures', async () => {
    mocks.getTopMedia.mockRejectedValue(new Error('[Tracearr] down'));
    await expect(
      getTracearrCollectionStats({
        limit: 5,
        statType: 'plays',
        days: 30,
        collectionRatingKeys: ['10'],
      })
    ).rejects.toThrow('down');
  });
});

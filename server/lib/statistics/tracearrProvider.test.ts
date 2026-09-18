import type { TracearrHistoryRow } from '@server/api/tracearr';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
}));

vi.mock('@server/lib/cache', () => ({
  default: {
    getCache: () => ({
      data: {
        get: (key: string) => state.store.get(key),
        set: (key: string, value: unknown) => state.store.set(key, value),
      },
    }),
  },
}));

vi.mock('@server/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('axios', () => {
  const instance = { get: vi.fn() };
  return {
    default: { create: vi.fn(() => instance), __instance: instance },
  };
});

import { TracearrStatisticsProvider } from './tracearrProvider';

const mockGet = (
  axios as unknown as { __instance: { get: ReturnType<typeof vi.fn> } }
).__instance.get;

const PLEX_SERVER = 'd0465c72-88ea-41a6-83d9-d0c33404646d';

/** Captured Tracearr v2.2.3 responses; see server/api/__fixtures__ */
const fixture = (name: string) => ({
  data: JSON.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        '..',
        '..',
        'api',
        '__fixtures__',
        `tracearr-${name}.json`
      ),
      'utf-8'
    )
  ),
});

const notFound = { response: { status: 404 }, message: 'Not Found' };

const page = <T>(data: T[]) => ({
  data: { data, meta: { nextCursor: null, pageSize: 100 } },
});

/** Users page mapping the two watchers in the show fixture to Plex ids */
const usersPage = page([
  {
    id: 'u1',
    username: 'moviefan',
    email: null,
    plex_account_id: null,
    accounts: [
      {
        server_id: PLEX_SERVER,
        server_type: 'plex',
        server_user_id: 'c95ed99a-412f-4430-8565-56ef7979ef89',
        external_user_id: '18889081',
        username: 'moviefan',
        removed_at: null,
      },
    ],
  },
  {
    id: 'u2',
    username: 'binger',
    email: null,
    plex_account_id: null,
    accounts: [
      {
        server_id: PLEX_SERVER,
        server_type: 'plex',
        server_user_id: '0225e254-1c0d-4728-9a1c-512f5af332e9',
        external_user_id: '307611349',
        username: 'binger',
        removed_at: null,
      },
    ],
  },
]);

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const historyRow = (
  overrides: Partial<TracearrHistoryRow>
): TracearrHistoryRow =>
  ({
    id: 'play',
    server_id: PLEX_SERVER,
    media_type: 'movie',
    media_title: 'Solo',
    rating_key: '7431',
    grandparent_rating_key: null,
    duration_ms: 60_000,
    started_at: daysAgo(1),
    user: { id: 'u1', server_user_id: 'su1', username: 'alice' },
    ...overrides,
  } as TracearrHistoryRow);

describe('TracearrStatisticsProvider.getMediaWatchData', () => {
  const provider = () =>
    new TracearrStatisticsProvider(
      {
        hostname: '192.168.4.3',
        port: 9246,
        useSsl: false,
        apiKey: 'trr_pub_test',
        serverId: PLEX_SERVER,
      },
      () => Promise.reject(new Error('plex not needed'))
    );

  beforeEach(() => {
    state.store.clear();
    mockGet.mockReset();
  });

  it('reads a show from the stats and watchers routes', async () => {
    mockGet
      .mockResolvedValueOnce(fixture('media-stats-show'))
      .mockResolvedValueOnce(fixture('media-watchers-show'))
      .mockResolvedValueOnce(usersPage);

    const data = await provider().getMediaWatchData({
      ratingKey: '116',
      mediaType: 'tv',
      tmdbId: 125988,
      tvdbId: 403245,
    });

    expect(data).toEqual({
      playCount: 40,
      playCount7Days: 7,
      playCount30Days: 7,
      plexUserIds: [18889081, 307611349],
    });
    // tmdb is preferred for the ref; watchers are scoped to the Plex server
    expect(mockGet).toHaveBeenNthCalledWith(
      1,
      '/api/v2/public/media/show%3Atmdb%3A125988/stats',
      { params: {} }
    );
    expect(mockGet).toHaveBeenNthCalledWith(
      2,
      '/api/v2/public/media/show%3Atmdb%3A125988/watchers',
      { params: { window: 'all_time', server_id: PLEX_SERVER } }
    );
    // No history paging at all
    expect(mockGet).toHaveBeenCalledTimes(3);
  });

  it('counts only the scoped server when a movie was played elsewhere too', async () => {
    mockGet
      .mockResolvedValueOnce(fixture('media-stats-movie'))
      .mockResolvedValueOnce({
        data: {
          media_id: 'm',
          media_type: 'movie',
          window: 'all_time',
          watchers: [],
        },
      });

    const data = await provider().getMediaWatchData({
      ratingKey: '29897',
      mediaType: 'movie',
      tmdbId: 1101383,
    });

    // The fixture has one play on Plex and one on Emby; combined would be 2
    expect(data).toEqual({
      playCount: 1,
      playCount7Days: 1,
      playCount30Days: 1,
      plexUserIds: [],
    });
    // Nobody to map, so the users page was not requested
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('falls back to rating-key history for a movie Tracearr cannot match', async () => {
    mockGet
      .mockRejectedValueOnce(notFound)
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce(
        page([
          historyRow({ id: 'a', started_at: daysAgo(1) }),
          historyRow({
            id: 'b',
            started_at: daysAgo(10),
            user: { id: 'u2', server_user_id: 'su2', username: 'bob' },
          }),
          historyRow({ id: 'c', started_at: daysAgo(60) }),
        ])
      )
      .mockResolvedValueOnce(
        page([
          {
            id: 'u1',
            username: 'alice',
            email: null,
            plex_account_id: null,
            accounts: [
              {
                server_id: PLEX_SERVER,
                server_type: 'plex',
                server_user_id: 'su1',
                external_user_id: '111',
                username: 'alice',
                removed_at: null,
              },
            ],
          },
        ])
      );

    const data = await provider().getMediaWatchData({
      ratingKey: '7431',
      mediaType: 'movie',
      tmdbId: 999,
    });

    expect(data).toEqual({
      playCount: 3,
      playCount7Days: 1,
      playCount30Days: 2,
      plexUserIds: [111],
    });
    expect(mockGet).toHaveBeenNthCalledWith(
      3,
      '/api/v2/public/history',
      expect.objectContaining({
        params: expect.objectContaining({
          server_id: PLEX_SERVER,
          media_type: 'movie',
          rating_key: '7431',
        }),
      })
    );
  });

  it('goes straight to history for a movie with no provider ids', async () => {
    mockGet.mockResolvedValueOnce(page([historyRow({ id: 'a' })]));
    mockGet.mockResolvedValueOnce(page([]));

    const data = await provider().getMediaWatchData({
      ratingKey: '7431',
      mediaType: 'movie',
    });

    expect(data.playCount).toBe(1);
    expect(mockGet).toHaveBeenNthCalledWith(
      1,
      '/api/v2/public/history',
      expect.anything()
    );
  });

  it('reports no plays for a show Tracearr cannot match', async () => {
    mockGet.mockRejectedValueOnce(notFound).mockRejectedValueOnce(notFound);

    const data = await provider().getMediaWatchData({
      ratingKey: '116',
      mediaType: 'tv',
      tvdbId: 1,
    });

    expect(data).toEqual({
      playCount: 0,
      playCount7Days: 0,
      playCount30Days: 0,
      plexUserIds: [],
    });
    // Episode history cannot be filtered by show rating key, so no fallback
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});

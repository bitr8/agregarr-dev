import axios from 'axios';
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
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('axios', () => {
  const instance = { get: vi.fn() };
  return {
    default: { create: vi.fn(() => instance), __instance: instance },
  };
});

import TracearrAPI, {
  aggregateHistoryRows,
  groupHistoryRowsByItem,
  type TracearrHistoryRow,
} from './tracearr';

const mockGet = (
  axios as unknown as { __instance: { get: ReturnType<typeof vi.fn> } }
).__instance.get;

const PLEX_SERVER = 'd0465c72-88ea-41a6-83d9-d0c33404646d';
const EMBY_SERVER = '6ea86a86-355d-4cd7-affc-7026a2a3a787';

function row(overrides: Partial<TracearrHistoryRow>): TracearrHistoryRow {
  return {
    id: 'play',
    server_id: PLEX_SERVER,
    server_name: 'Plex',
    server_type: 'plex',
    media_type: 'movie',
    media_title: 'The Beekeeper',
    show_title: null,
    season_number: null,
    episode_number: null,
    year: 2024,
    duration_ms: 60_000,
    progress_ms: null,
    total_duration_ms: null,
    percent_complete: null,
    started_at: '2026-09-10T17:56:22.137Z',
    stopped_at: null,
    watched: true,
    media_id: null,
    show_media_id: null,
    imdb_id: null,
    tmdb_id: null,
    tvdb_id: null,
    rating_key: '7431',
    parent_rating_key: null,
    grandparent_rating_key: null,
    library_id: '1',
    user: { id: 'u1', server_user_id: 'su1', username: 'alice' },
    ...overrides,
  };
}

describe('aggregateHistoryRows', () => {
  it('rolls movie plays up by rating key with plays, duration and viewers', () => {
    const rows = [
      row({
        id: 'a',
        tmdb_id: 866398,
        user: { id: 'u1', server_user_id: 'su1', username: 'alice' },
      }),
      row({
        id: 'b',
        duration_ms: 120_000,
        started_at: '2026-09-11T10:00:00.000Z',
        user: { id: 'u2', server_user_id: 'su2', username: 'bob' },
      }),
      row({
        id: 'c',
        user: { id: 'u1', server_user_id: 'su1', username: 'alice' },
      }),
      row({ id: 'd', rating_key: '99', media_title: 'Other', tmdb_id: 1 }),
    ];

    const items = aggregateHistoryRows(rows, 'movie');

    expect(items.size).toBe(2);
    const beekeeper = items.get('7431');
    expect(beekeeper).toMatchObject({
      ratingKey: '7431',
      title: 'The Beekeeper',
      mediaType: 'movie',
      year: 2024,
      tmdbId: 866398,
      totalPlays: 3,
      totalDuration: 240,
    });
    expect(beekeeper?.serverUserIds.size).toBe(2);
    expect(beekeeper?.lastPlayed).toBe(
      Math.floor(new Date('2026-09-11T10:00:00.000Z').getTime() / 1000)
    );
  });

  it('rolls episode plays up to the show and omits episode-level provider ids', () => {
    const rows = [
      row({
        id: 'a',
        media_type: 'episode',
        media_title: 'Ep 1',
        show_title: 'Project Runway',
        rating_key: '28628',
        grandparent_rating_key: '19418',
        tmdb_id: 7611702,
      }),
      row({
        id: 'b',
        media_type: 'episode',
        media_title: 'Ep 2',
        show_title: 'Project Runway',
        rating_key: '28629',
        grandparent_rating_key: '19418',
        tmdb_id: 7611703,
        user: { id: 'u2', server_user_id: 'su2', username: 'bob' },
      }),
    ];

    const items = aggregateHistoryRows(rows, 'tv');

    expect(items.size).toBe(1);
    expect(items.get('19418')).toMatchObject({
      title: 'Project Runway',
      mediaType: 'show',
      totalPlays: 2,
    });
    expect(items.get('19418')?.tmdbId).toBeUndefined();
  });

  it('filters by media type and drops rows without a usable key', () => {
    const rows = [
      row({ id: 'a' }),
      row({ id: 'b', media_type: 'episode', grandparent_rating_key: '19418' }),
      row({ id: 'c', media_type: 'episode', grandparent_rating_key: null }),
      row({ id: 'd', media_type: 'track', rating_key: '5' }),
      row({ id: 'e', rating_key: null }),
    ];

    expect(Array.from(aggregateHistoryRows(rows, 'movie').keys())).toEqual([
      '7431',
    ]);
    expect(Array.from(aggregateHistoryRows(rows, 'tv').keys())).toEqual([
      '19418',
    ]);
    expect(aggregateHistoryRows(rows).size).toBe(2);
  });
});

describe('groupHistoryRowsByItem', () => {
  it('groups movies by rating key and episodes by show key', () => {
    const rows = [
      row({ id: 'a' }),
      row({ id: 'b', media_type: 'episode', grandparent_rating_key: '19418' }),
      row({ id: 'c', media_type: 'episode', grandparent_rating_key: '19418' }),
      row({ id: 'd', media_type: 'photo' }),
    ];

    const grouped = groupHistoryRowsByItem(rows);

    expect(grouped.get('7431')?.map((r) => r.id)).toEqual(['a']);
    expect(grouped.get('19418')?.map((r) => r.id)).toEqual(['b', 'c']);
    expect(grouped.size).toBe(2);
  });
});

describe('TracearrAPI', () => {
  const settings = {
    hostname: '192.168.4.3',
    port: 9246,
    useSsl: false,
    apiKey: 'trr_pub_test',
  };

  const health = {
    data: {
      status: 'ok',
      version: 'v2.2.3',
      timestamp: '',
      servers: [
        {
          id: EMBY_SERVER,
          name: 'Emby',
          type: 'emby',
          online: true,
          activeStreams: 0,
        },
        {
          id: PLEX_SERVER,
          name: 'Plex',
          type: 'plex',
          online: true,
          activeStreams: 0,
        },
      ],
    },
  };

  beforeEach(() => {
    state.store.clear();
    mockGet.mockReset();
  });

  it('sends the bearer token and resolves Plex servers from health', async () => {
    mockGet.mockResolvedValueOnce(health);
    const api = new TracearrAPI(settings);

    expect(vi.mocked(axios.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'http://192.168.4.3:9246',
        headers: expect.objectContaining({
          Authorization: 'Bearer trr_pub_test',
        }),
      })
    );
    await expect(api.getServerIds()).resolves.toEqual([PLEX_SERVER]);
    expect(mockGet).toHaveBeenCalledWith('/api/v1/public/health');
  });

  it('prefers an explicitly selected server without calling health', async () => {
    const api = new TracearrAPI({ ...settings, serverId: 'chosen' });
    await expect(api.getServerIds()).resolves.toEqual(['chosen']);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('follows history cursors, scopes by server and ranks content', async () => {
    const page1 = {
      data: {
        data: [
          row({
            id: 'a',
            rating_key: '1',
            media_title: 'Solo',
            user: { id: 'u1', server_user_id: 'su1', username: 'a' },
          }),
          row({
            id: 'b',
            rating_key: '1',
            media_title: 'Solo',
            user: { id: 'u1', server_user_id: 'su1', username: 'a' },
          }),
          row({
            id: 'c',
            rating_key: '1',
            media_title: 'Solo',
            user: { id: 'u1', server_user_id: 'su1', username: 'a' },
          }),
        ],
        meta: { nextCursor: 'cursor-1', pageSize: 100 },
      },
    };
    const page2 = {
      data: {
        data: [
          row({
            id: 'd',
            rating_key: '2',
            media_title: 'Shared',
            duration_ms: 3_600_000,
            user: { id: 'u1', server_user_id: 'su1', username: 'a' },
          }),
          row({
            id: 'e',
            rating_key: '2',
            media_title: 'Shared',
            duration_ms: 3_600_000,
            user: { id: 'u2', server_user_id: 'su2', username: 'b' },
          }),
        ],
        meta: { nextCursor: null, pageSize: 100 },
      },
    };
    mockGet
      .mockResolvedValueOnce(health)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);

    const api = new TracearrAPI(settings);
    const popular = await api.getContent(
      'movie',
      30,
      'plays',
      'most_popular',
      10
    );

    expect(mockGet).toHaveBeenCalledTimes(3);
    const [, firstCall] = mockGet.mock.calls[1];
    expect(firstCall.params).toMatchObject({
      server_id: PLEX_SERVER,
      pageSize: 100,
    });
    // One pull covers every media type so movie/TV/collection callers share it
    expect(firstCall.params.media_type).toBeUndefined();
    expect(firstCall.params.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(mockGet.mock.calls[2][1].params.cursor).toBe('cursor-1');

    // most_popular: distinct viewers first (Shared has 2, Solo has 1)
    expect(popular.map((i) => i.ratingKey)).toEqual(['2', '1']);

    // most_watched by plays: Solo (3) beats Shared (2); history pull is cached
    const watched = await api.getContent(
      'movie',
      30,
      'plays',
      'most_watched',
      10
    );
    expect(watched.map((i) => i.ratingKey)).toEqual(['1', '2']);
    expect(mockGet).toHaveBeenCalledTimes(3);

    // most_watched by duration: Shared (7200s) beats Solo (180s)
    const byDuration = await api.getContent(
      'movie',
      30,
      'duration',
      'most_watched',
      1
    );
    expect(byDuration.map((i) => i.ratingKey)).toEqual(['2']);

    // The TV list over the same window reuses the cached pull too
    await api.getContent('tv', 30, 'plays', 'most_popular', 10);
    expect(mockGet).toHaveBeenCalledTimes(3);
  });

  it('shares one in-flight pull between concurrent callers', async () => {
    let resolvePage: (value: unknown) => void = () => undefined;
    mockGet.mockResolvedValueOnce(health).mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePage = resolve;
      })
    );

    const api = new TracearrAPI(settings);
    // Resolve servers up front so both callers go straight to the history pull
    await api.getServerIds();
    const first = api.getContent('movie', 7, 'plays', 'most_watched', 5);
    const second = api.getContent('tv', 7, 'plays', 'most_watched', 5);
    await new Promise((r) => setTimeout(r, 0));

    resolvePage({
      data: {
        data: [
          row({ id: 'a' }),
          row({
            id: 'b',
            media_type: 'episode',
            grandparent_rating_key: '19418',
            show_title: 'Show',
          }),
        ],
        meta: { nextCursor: null, pageSize: 100 },
      },
    });

    const [movies, shows] = await Promise.all([first, second]);
    expect(movies.map((i) => i.ratingKey)).toEqual(['7431']);
    expect(shows.map((i) => i.ratingKey)).toEqual(['19418']);
    // health + exactly one history request despite two concurrent callers
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('maps Plex accounts to numeric Plex ids', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        data: [
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
                external_user_id: '18889081',
                username: 'alice',
                removed_at: null,
              },
              {
                server_id: EMBY_SERVER,
                server_type: 'emby',
                server_user_id: 'su9',
                external_user_id: 'abc',
                username: 'alice',
                removed_at: null,
              },
            ],
          },
        ],
        meta: { nextCursor: null, pageSize: 100 },
      },
    });

    const api = new TracearrAPI(settings);
    const map = await api.getPlexUserIdMap();

    expect(map.get('su1')).toBe(18889081);
    expect(map.has('su9')).toBe(false);
  });

  it('returns null for unknown media refs', async () => {
    mockGet.mockRejectedValueOnce({ response: { status: 404 }, message: 'nf' });
    const api = new TracearrAPI(settings);
    await expect(api.getMedia('show:tmdb:1')).resolves.toBeNull();
  });
});

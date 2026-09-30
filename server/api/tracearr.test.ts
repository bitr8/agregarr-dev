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

  it('refuses to guess when Tracearr monitors several Plex servers', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        ...health.data,
        servers: [
          ...health.data.servers,
          {
            id: 'second-plex',
            name: 'Plex 2',
            type: 'plex',
            online: true,
            activeStreams: 0,
          },
        ],
      },
    });
    const api = new TracearrAPI(settings);

    await expect(api.getServerIds()).rejects.toThrow(/select the one/);
    // Selecting one skips health entirely, so the same client works scoped
    const scoped = new TracearrAPI({ ...settings, serverId: 'second-plex' });
    await expect(scoped.getServerIds()).resolves.toEqual(['second-plex']);
  });

  it('fails instead of caching a truncated history pull', async () => {
    mockGet.mockResolvedValueOnce(health).mockResolvedValue({
      data: {
        data: [row({ id: 'x' })],
        meta: { nextCursor: 'more', pageSize: 100 },
      },
    });
    const api = new TracearrAPI(settings);

    await expect(api.getHistoryForDays(0)).rejects.toThrow(/more than 50000/);
    // Nothing was cached, so the next call pulls again rather than serving
    // the partial result
    mockGet.mockClear();
    await expect(api.getHistoryForDays(0)).rejects.toThrow();
    expect(mockGet).toHaveBeenCalled();
  });

  it('retries a page after a 429, honouring Retry-After', async () => {
    vi.useFakeTimers();
    try {
      mockGet
        .mockResolvedValueOnce(health)
        .mockRejectedValueOnce({
          response: { status: 429, headers: { 'retry-after': '2' } },
          message: 'Too Many Requests',
        })
        .mockResolvedValueOnce({
          data: {
            data: [row({ id: 'a' })],
            meta: { nextCursor: null, pageSize: 100 },
          },
        });
      const api = new TracearrAPI(settings);

      const pending = api.getHistoryForDays(30);
      await vi.advanceTimersByTimeAsync(2000);
      const rows = await pending;

      expect(rows.map((r) => r.id)).toEqual(['a']);
      // health + failed page + retried page
      expect(mockGet).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after repeated 429s', async () => {
    vi.useFakeTimers();
    try {
      const limited = {
        response: { status: 429, headers: {} },
        message: 'Too Many Requests',
      };
      mockGet.mockResolvedValueOnce(health).mockRejectedValue(limited);
      const api = new TracearrAPI(settings);

      const pending = api.getHistoryForDays(30);
      // Attach the handler before advancing so the rejection is observed
      const outcome = pending.catch((e) => e);
      await vi.advanceTimersByTimeAsync(10_000);
      const error = await outcome;

      expect(error.message).toMatch(/Too Many Requests/);
      // health + initial page + two retries
      expect(mockGet).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
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

/**
 * Responses captured from Tracearr v2.2.3 (2026-09-16) so the client is
 * tested against the real wire shape, not just the handwritten rows above.
 * Viewer usernames and avatar URLs were replaced; everything else is verbatim.
 */
describe('captured Tracearr v2.2.3 responses', () => {
  const settings = {
    hostname: '192.168.4.3',
    port: 9246,
    useSsl: false,
    apiKey: 'trr_pub_test',
  };

  const fixture = (name: string) => ({
    data: JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '__fixtures__', `tracearr-${name}.json`),
        'utf-8'
      )
    ),
  });

  beforeEach(() => {
    state.store.clear();
    mockGet.mockReset();
  });

  it('handwritten rows use only fields the real history rows carry', () => {
    const [movie, episode] = fixture('history').data.data;
    for (const key of Object.keys(row({}))) {
      expect(movie).toHaveProperty(key);
      expect(episode).toHaveProperty(key);
    }
    for (const key of Object.keys(row({}).user)) {
      expect(movie.user).toHaveProperty(key);
    }
  });

  it('ranks movies and shows from a real history page', async () => {
    // The captured page has a real nextCursor, so the client follows it and
    // is answered with an empty final page
    mockGet
      .mockResolvedValueOnce(fixture('health'))
      .mockResolvedValueOnce(fixture('history'))
      .mockResolvedValueOnce({
        data: { data: [], meta: { nextCursor: null, pageSize: 100 } },
      });
    const api = new TracearrAPI(settings);

    const movies = await api.getContent('movie', 30, 'plays', 'most_watched');
    expect(movies).toHaveLength(1);
    expect(movies[0]).toMatchObject({
      ratingKey: '29897',
      title: 'The End of Oak Street',
      mediaType: 'movie',
      year: 2026,
      tmdbId: 1101383,
      tvdbId: 358926,
      imdbId: 'tt27165187',
      totalPlays: 1,
      totalDuration: 5574,
      lastPlayed: Math.floor(Date.parse('2026-09-15T13:06:48.990Z') / 1000),
    });
    expect(movies[0].serverUserIds).toEqual(
      new Set(['c95ed99a-412f-4430-8565-56ef7979ef89'])
    );

    const shows = await api.getContent('tv', 30, 'plays', 'most_watched');
    expect(shows).toHaveLength(1);
    // Episodes roll up to the show's (grandparent) rating key and carry no
    // show-level provider ids
    expect(shows[0]).toMatchObject({
      ratingKey: '116',
      title: 'Silo',
      mediaType: 'show',
      totalPlays: 1,
    });
    expect(shows[0].tmdbId).toBeUndefined();

    // Only the Plex server is scoped, and the second page was requested
    // with the captured cursor
    expect(mockGet).toHaveBeenCalledTimes(3);
    expect(mockGet).toHaveBeenLastCalledWith(
      '/api/v2/public/history',
      expect.objectContaining({
        params: expect.objectContaining({
          server_id: PLEX_SERVER,
          pageSize: 100,
          cursor: fixture('history').data.meta.nextCursor,
        }),
      })
    );
  });

  it('maps a real users page to Plex account ids', async () => {
    mockGet.mockResolvedValueOnce(fixture('users'));
    const api = new TracearrAPI(settings);

    const map = await api.getPlexUserIdMap();
    expect(map.get('f933968c-1dad-4c23-b919-dc1e6227e3c5')).toBe(307611349);
    // The Emby-only identity has no Plex account and is skipped
    expect(map.size).toBe(1);
    expect(mockGet).toHaveBeenCalledWith(
      '/api/v2/public/users',
      expect.objectContaining({
        params: expect.objectContaining({ include_removed: true }),
      })
    );
  });

  it('reads real per-server media stats and caches them', async () => {
    mockGet.mockResolvedValueOnce(fixture('media-stats-movie'));
    const api = new TracearrAPI(settings);

    const stats = await api.getMediaStats('movie:tmdb:1101383');
    expect(stats?.media_type).toBe('movie');
    expect(Object.keys(stats?.windows ?? {})).toEqual([
      'all_time',
      'last_30',
      'last_7',
    ]);
    // Same film played once on Plex and once on Emby
    expect(stats?.windows.all_time.combined.plays).toBe(2);
    expect(
      stats?.windows.all_time.per_server.map((s) => [s.server_id, s.plays])
    ).toEqual([
      [EMBY_SERVER, 1],
      [PLEX_SERVER, 1],
    ]);
    expect(mockGet).toHaveBeenCalledWith(
      '/api/v2/public/media/movie%3Atmdb%3A1101383/stats',
      { params: {} }
    );

    await api.getMediaStats('movie:tmdb:1101383');
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('reads real watchers scoped to a server', async () => {
    mockGet.mockResolvedValueOnce(fixture('media-watchers-show'));
    const api = new TracearrAPI(settings);

    const watchers = await api.getMediaWatchers(
      'show:tvdb:403245',
      PLEX_SERVER
    );
    expect(watchers?.window).toBe('all_time');
    expect(
      watchers?.watchers.map((w) => [w.user.server_user_id, w.plays])
    ).toEqual([
      ['c95ed99a-412f-4430-8565-56ef7979ef89', 23],
      ['0225e254-1c0d-4728-9a1c-512f5af332e9', 17],
    ]);
    expect(mockGet).toHaveBeenCalledWith(
      '/api/v2/public/media/show%3Atvdb%3A403245/watchers',
      { params: { window: 'all_time', server_id: PLEX_SERVER } }
    );
  });

  it('returns null stats for an unknown ref', async () => {
    mockGet.mockRejectedValueOnce({ response: { status: 404 }, message: 'nf' });
    const api = new TracearrAPI(settings);
    await expect(api.getMediaStats('movie:tmdb:1')).resolves.toBeNull();
  });

  it('reads a real media record', async () => {
    mockGet.mockResolvedValueOnce(fixture('media-show'));
    const api = new TracearrAPI(settings);

    const media = await api.getMedia('show:tvdb:403245');
    expect(media).toMatchObject({
      id: '9cec04ae-b067-479a-a6ec-21b87646ac6e',
      media_type: 'show',
      title: 'Silo',
      tmdb_id: 125988,
      tvdb_id: 403245,
      imdb_id: 'tt14688458',
    });
    expect(mockGet).toHaveBeenCalledWith(
      '/api/v2/public/media/show%3Atvdb%3A403245'
    );
  });
});

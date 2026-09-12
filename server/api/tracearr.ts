import cacheManager from '@server/lib/cache';
import type { TracearrSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { AxiosInstance } from 'axios';
import axios from 'axios';

/**
 * Tracearr public API client
 *
 * Tracearr (https://github.com/connorgallopo/Tracearr) exposes a read-only
 * public REST API authenticated with a bearer token (`trr_pub_...`). Agregarr
 * uses:
 *
 *   GET /api/v1/public/health     - version + monitored servers (connection test)
 *   GET /api/v2/public/history    - cursor-paginated plays with media identity
 *   GET /api/v2/public/users      - identities with per-server account ids
 *   GET /api/v2/public/media/:ref - canonical media lookup by provider id
 *
 * Tracearr has no "top N" endpoint, so popularity is derived here from the
 * play log: one history row is one play (a resume chain), and rows carry the
 * Plex rating key, grandparent (show) rating key, duration and the viewer.
 */

const LABEL = 'Tracearr API';

/** Public API limit is 240 requests/minute per token; stay well under it. */
const PAGE_SIZE = 100;
/** Hard stop for a single history pull (500 pages = 50k plays). */
const MAX_HISTORY_PAGES = 500;
/** Repeated dashboard/preview calls within this window reuse one pull. */
const HISTORY_CACHE_TTL_SECONDS = 300;

/**
 * In-flight history pulls keyed by cache key. Tracearr serialises concurrent
 * history queries (a parallel third request waits ~2.5s instead of ~0.3s),
 * so simultaneous callers must share one request rather than race.
 */
const inflightHistory = new Map<string, Promise<TracearrHistoryRow[]>>();

export interface TracearrServer {
  id: string;
  name: string;
  type: string; // 'plex' | 'emby' | 'jellyfin'
  online: boolean;
  activeStreams: number;
}

export interface TracearrHealth {
  status: string;
  version: string;
  timestamp: string;
  servers: TracearrServer[];
}

export interface TracearrHistoryRow {
  id: string;
  server_id: string;
  server_name: string;
  server_type: string;
  media_type: string; // 'movie' | 'episode' | 'track' | ...
  media_title: string;
  show_title: string | null;
  season_number: number | null;
  episode_number: number | null;
  year: number | null;
  duration_ms: number | null;
  progress_ms: number | string | null;
  total_duration_ms: number | string | null;
  percent_complete: number | null;
  started_at: string;
  stopped_at: string | null;
  watched: boolean;
  media_id: string | null;
  show_media_id: string | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
  rating_key: string | null;
  parent_rating_key: string | null;
  grandparent_rating_key: string | null;
  library_id: string | null;
  user: {
    id: string;
    server_user_id: string;
    username: string | null;
    thumb_url?: string | null;
    avatar_url?: string | null;
  };
}

export interface TracearrUserAccount {
  server_id: string;
  server_type: string;
  server_user_id: string;
  /** The media server's own user id; for Plex this is the numeric Plex account id */
  external_user_id: string;
  username: string;
  removed_at: string | null;
}

export interface TracearrUser {
  id: string;
  username: string;
  email: string | null;
  plex_account_id: string | null;
  accounts: TracearrUserAccount[];
}

export interface TracearrMedia {
  id: string;
  media_type: 'movie' | 'show' | 'season' | 'episode';
  title: string;
  year: number | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
  show_media_id: string | null;
}

interface CursorPage<T> {
  data: T[];
  meta: { nextCursor: string | null; pageSize: number };
}

export interface TracearrHistoryQuery {
  serverId?: string;
  mediaType?: 'movie' | 'episode';
  since?: Date;
  until?: Date;
  ratingKey?: string;
  mediaId?: string;
  tmdbId?: number;
  userId?: string;
}

/**
 * Per-item rollup of history rows. For movies the key is the movie rating
 * key; for TV the key is the show (grandparent) rating key so every episode
 * play counts toward its show, matching Tautulli's `top_tv` behaviour.
 */
export interface TracearrItemStats {
  ratingKey: string;
  title: string;
  mediaType: 'movie' | 'show';
  year?: number;
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
  totalPlays: number;
  /** Seconds, to match Tautulli's `total_duration` */
  totalDuration: number;
  /** Distinct Tracearr server-user ids */
  serverUserIds: Set<string>;
  /** Unix seconds of the most recent play */
  lastPlayed?: number;
}

/**
 * Group history rows into per-title stats. Pure and exported for tests.
 *
 * @param rows History rows (any media types; non movie/episode rows are ignored)
 * @param mediaType Restrict to movies or TV shows; omit to keep both
 */
export function aggregateHistoryRows(
  rows: TracearrHistoryRow[],
  mediaType?: 'movie' | 'tv'
): Map<string, TracearrItemStats> {
  const items = new Map<string, TracearrItemStats>();

  for (const row of rows) {
    let key: string | null = null;
    let stats: Omit<
      TracearrItemStats,
      'totalPlays' | 'totalDuration' | 'serverUserIds' | 'lastPlayed'
    > | null = null;

    if (row.media_type === 'movie' && mediaType !== 'tv') {
      key = row.rating_key;
      if (key) {
        stats = {
          ratingKey: key,
          title: row.media_title,
          mediaType: 'movie',
          year: row.year ?? undefined,
          tmdbId: row.tmdb_id ?? undefined,
          tvdbId: row.tvdb_id ?? undefined,
          imdbId: row.imdb_id ?? undefined,
        };
      }
    } else if (row.media_type === 'episode' && mediaType !== 'movie') {
      key = row.grandparent_rating_key;
      if (key) {
        // Episode rows carry the *episode's* provider ids; the show's ids are
        // resolved later from Plex metadata, so they are deliberately omitted.
        stats = {
          ratingKey: key,
          title: row.show_title || row.media_title,
          mediaType: 'show',
        };
      }
    }

    if (!key || !stats) {
      continue;
    }

    const playedAt = Math.floor(new Date(row.started_at).getTime() / 1000);
    const durationSeconds = Math.round((row.duration_ms ?? 0) / 1000);

    const existing = items.get(key);
    if (existing) {
      existing.totalPlays += 1;
      existing.totalDuration += durationSeconds;
      existing.serverUserIds.add(row.user.server_user_id);
      if (!existing.lastPlayed || playedAt > existing.lastPlayed) {
        existing.lastPlayed = playedAt;
      }
      // Prefer a row that has provider ids (movies only)
      if (!existing.tmdbId && stats.tmdbId) existing.tmdbId = stats.tmdbId;
      if (!existing.tvdbId && stats.tvdbId) existing.tvdbId = stats.tvdbId;
      if (!existing.imdbId && stats.imdbId) existing.imdbId = stats.imdbId;
      if (!existing.year && stats.year) existing.year = stats.year;
    } else {
      items.set(key, {
        ...stats,
        totalPlays: 1,
        totalDuration: durationSeconds,
        serverUserIds: new Set([row.user.server_user_id]),
        lastPlayed: Number.isFinite(playedAt) ? playedAt : undefined,
      });
    }
  }

  return items;
}

/**
 * Group rows by the Plex item they count toward: the movie rating key for
 * movies, the show (grandparent) rating key for episodes. Rows of other
 * media types, or without a usable key, are dropped. Pure; exported for tests.
 */
export function groupHistoryRowsByItem(
  rows: TracearrHistoryRow[]
): Map<string, TracearrHistoryRow[]> {
  const grouped = new Map<string, TracearrHistoryRow[]>();
  for (const row of rows) {
    const key =
      row.media_type === 'movie'
        ? row.rating_key
        : row.media_type === 'episode'
        ? row.grandparent_rating_key
        : null;
    if (!key) continue;
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      grouped.set(key, [row]);
    }
  }
  return grouped;
}

class TracearrAPI {
  private axios: AxiosInstance;
  private baseUrl: string;
  private settings: TracearrSettings;

  constructor(settings: TracearrSettings) {
    const protocol = settings.useSsl ? 'https' : 'http';
    const port = settings.port ? `:${settings.port}` : '';
    const urlBase = settings.urlBase ?? '';

    this.settings = settings;
    this.baseUrl = `${protocol}://${settings.hostname}${port}${urlBase}`;
    this.axios = axios.create({
      baseURL: this.baseUrl,
      headers: {
        Authorization: `Bearer ${settings.apiKey ?? ''}`,
        Accept: 'application/json',
      },
      timeout: 30000,
    });
  }

  private get cache() {
    return cacheManager.getCache('tracearr').data;
  }

  private cacheKey(name: string, params: unknown): string {
    return `${this.baseUrl}:${name}:${JSON.stringify(params ?? {})}`;
  }

  /**
   * Connection test. Errors are rethrown untouched so callers can inspect
   * the HTTP status (401 = bad token, 404 = wrong URL base).
   */
  public async getHealth(): Promise<TracearrHealth> {
    const response = await this.axios.get<TracearrHealth>(
      '/api/v1/public/health'
    );
    return response.data;
  }

  /**
   * Tracearr server ids whose history should be queried. Uses the explicitly
   * selected server when configured, otherwise every Plex-type server.
   */
  public async getServerIds(): Promise<string[]> {
    if (this.settings.serverId) {
      return [this.settings.serverId];
    }

    const key = this.cacheKey('servers', null);
    const cached = this.cache.get<string[]>(key);
    if (cached) {
      return cached;
    }

    try {
      const health = await this.getHealth();
      const plexServers = health.servers.filter((s) => s.type === 'plex');
      if (plexServers.length === 0) {
        throw new Error(
          'Tracearr is not monitoring any Plex server - select a server in the Tracearr settings'
        );
      }
      if (plexServers.length > 1) {
        logger.warn(
          'Tracearr monitors several Plex servers; history from all of them will be combined. Select one in the Tracearr settings to scope statistics.',
          { label: LABEL, servers: plexServers.map((s) => s.name) }
        );
      }
      const ids = plexServers.map((s) => s.id);
      this.cache.set(key, ids, HISTORY_CACHE_TTL_SECONDS);
      return ids;
    } catch (e) {
      logger.error('Failed to resolve Tracearr servers', {
        label: LABEL,
        errorMessage: e.message,
      });
      throw new Error(`[Tracearr] Failed to resolve servers: ${e.message}`);
    }
  }

  private async fetchPages<T>(
    endpoint: string,
    params: Record<string, string | number | boolean | undefined>,
    maxPages = MAX_HISTORY_PAGES
  ): Promise<T[]> {
    const rows: T[] = [];
    let cursor: string | undefined;
    let page = 0;

    do {
      const response = await this.axios.get<CursorPage<T>>(endpoint, {
        params: { ...params, pageSize: PAGE_SIZE, cursor },
      });
      rows.push(...response.data.data);
      cursor = response.data.meta?.nextCursor ?? undefined;
      page += 1;
      if (page >= maxPages && cursor) {
        logger.warn(`Stopped paging ${endpoint} after ${maxPages} pages`, {
          label: LABEL,
          rows: rows.length,
        });
        break;
      }
    } while (cursor);

    return rows;
  }

  /**
   * Fetch plays matching the query across the scoped servers (unless a
   * specific serverId is given). Results are cached briefly so the several
   * dashboard calls made per page load share one pull.
   */
  public async getHistory(
    query: TracearrHistoryQuery = {}
  ): Promise<TracearrHistoryRow[]> {
    const serverIds = query.serverId
      ? [query.serverId]
      : await this.getServerIds();

    const key = this.cacheKey('history', {
      ...query,
      since: query.since?.toISOString(),
      until: query.until?.toISOString(),
      serverIds,
    });
    const cached = this.cache.get<TracearrHistoryRow[]>(key);
    if (cached) {
      return cached;
    }

    const pending = inflightHistory.get(key);
    if (pending) {
      return pending;
    }

    const request = this.fetchHistory(query, serverIds)
      .then((rows) => {
        this.cache.set(key, rows, HISTORY_CACHE_TTL_SECONDS);
        return rows;
      })
      .finally(() => {
        inflightHistory.delete(key);
      });
    inflightHistory.set(key, request);
    return request;
  }

  private async fetchHistory(
    query: TracearrHistoryQuery,
    serverIds: string[]
  ): Promise<TracearrHistoryRow[]> {
    try {
      const rows: TracearrHistoryRow[] = [];
      for (const serverId of serverIds) {
        const pageRows = await this.fetchPages<TracearrHistoryRow>(
          '/api/v2/public/history',
          {
            server_id: serverId,
            media_type: query.mediaType,
            since: query.since?.toISOString(),
            until: query.until?.toISOString(),
            rating_key: query.ratingKey,
            media_id: query.mediaId,
            tmdb_id: query.tmdbId,
            user_id: query.userId,
          }
        );
        rows.push(...pageRows);
      }

      logger.debug('Fetched Tracearr history', {
        label: LABEL,
        rows: rows.length,
        servers: serverIds.length,
        mediaType: query.mediaType,
        since: query.since?.toISOString(),
      });

      return rows;
    } catch (e) {
      logger.error('Failed to fetch history from Tracearr', {
        label: LABEL,
        errorMessage: e.message,
        status: e.response?.status,
      });
      throw new Error(`[Tracearr] Failed to fetch history: ${e.message}`);
    }
  }

  /**
   * History for the last N days across all media types. `days <= 0` means
   * all time. Callers filter by media type locally so that movie lists, TV
   * lists and collection rollups over the same window share a single pull.
   */
  public async getHistoryForDays(days: number): Promise<TracearrHistoryRow[]> {
    // Round down to the minute so back-to-back calls (dashboard, previews)
    // produce an identical cache key and share one history pull.
    const since =
      days > 0
        ? new Date(
            Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 60_000) *
              60_000
          )
        : undefined;
    return this.getHistory({ since });
  }

  /**
   * Map of Tracearr server-user id -> Plex account id for the scoped servers.
   */
  public async getPlexUserIdMap(): Promise<Map<string, number>> {
    const key = this.cacheKey('users', null);
    const cached = this.cache.get<Map<string, number>>(key);
    if (cached) {
      return cached;
    }

    try {
      const users = await this.fetchPages<TracearrUser>(
        '/api/v2/public/users',
        { include_removed: true },
        50
      );
      const map = new Map<string, number>();
      for (const user of users) {
        for (const account of user.accounts) {
          if (account.server_type !== 'plex') continue;
          const plexId = Number(account.external_user_id);
          if (Number.isFinite(plexId)) {
            map.set(account.server_user_id, plexId);
          }
        }
      }
      this.cache.set(key, map, HISTORY_CACHE_TTL_SECONDS);
      return map;
    } catch (e) {
      logger.error('Failed to fetch users from Tracearr', {
        label: LABEL,
        errorMessage: e.message,
      });
      throw new Error(`[Tracearr] Failed to fetch users: ${e.message}`);
    }
  }

  /**
   * Resolve a canonical media record by uuid or provider ref such as
   * `movie:tmdb:603` / `show:tvdb:74285`. Returns null when unknown.
   */
  public async getMedia(ref: string): Promise<TracearrMedia | null> {
    try {
      const response = await this.axios.get<TracearrMedia>(
        `/api/v2/public/media/${encodeURIComponent(ref)}`
      );
      return response.data;
    } catch (e) {
      if (e.response?.status === 404) {
        return null;
      }
      logger.error('Failed to fetch media from Tracearr', {
        label: LABEL,
        errorMessage: e.message,
        ref,
      });
      throw new Error(`[Tracearr] Failed to fetch media: ${e.message}`);
    }
  }

  /**
   * Tautulli-style "top content" derived from the play log.
   *
   * @param collectionType most_popular ranks by distinct viewers (Tautulli's
   *   popular_* stats); most_watched ranks by plays or watch time.
   */
  public async getContent(
    mediaType: 'movie' | 'tv',
    timeRangeDays = 30,
    statType: 'plays' | 'duration' = 'plays',
    collectionType: 'most_popular' | 'most_watched' = 'most_popular',
    limit = 20
  ): Promise<TracearrItemStats[]> {
    const rows = await this.getHistoryForDays(timeRangeDays);
    const items = Array.from(aggregateHistoryRows(rows, mediaType).values());

    const byStat = (a: TracearrItemStats, b: TracearrItemStats) =>
      statType === 'duration'
        ? b.totalDuration - a.totalDuration
        : b.totalPlays - a.totalPlays;

    items.sort((a, b) => {
      if (collectionType === 'most_popular') {
        const viewers = b.serverUserIds.size - a.serverUserIds.size;
        if (viewers !== 0) return viewers;
      }
      const stat = byStat(a, b);
      if (stat !== 0) return stat;
      return (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0);
    });

    logger.debug('Derived top content from Tracearr history', {
      label: LABEL,
      mediaType,
      timeRangeDays,
      statType,
      collectionType,
      historyRows: rows.length,
      distinctItems: items.length,
    });

    return items.slice(0, limit);
  }
}

export default TracearrAPI;

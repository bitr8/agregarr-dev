import type { TracearrSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { AxiosInstance } from 'axios';
import axios from 'axios';
import { createHash } from 'crypto';

export const TRACEARR_MAX_DAYS = 365;
const PAGE_SIZE = 1000;
const DEFAULT_MAX_PAGES = 5;
const RATE_LIMIT_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 30000;
const CACHE_TTL_MS = 5 * 60 * 1000;

export type TracearrSort = 'plays' | 'watch_time' | 'viewers';

export interface TracearrTopMediaRow {
  media_id: string;
  media_type: 'movie' | 'show';
  title: string;
  year: number | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
  plays: number;
  watch_time_ms: number;
  unique_users: number;
  last_watched_day: string | null;
}

export interface TracearrServer {
  server_id: string;
  server_name: string;
  status: string;
  server_type: string;
}

export interface TracearrMediaAvailability {
  server_id: string;
  server_type: string;
  library_id: string | null;
  rating_key: string | null;
  removed_at?: string | null;
}

export interface TracearrMedia {
  id: string;
  media_type: string;
  title: string;
  year: number | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
  availability: TracearrMediaAvailability[];
}

export interface TracearrTopMediaResult {
  rows: TracearrTopMediaRow[];
  truncated: boolean;
}

interface TopMediaOptions {
  mediaType: 'movie' | 'show';
  days: number;
  sort: TracearrSort;
  maxPages?: number;
  minViewers?: number;
  bypassCache?: boolean;
}

export class TracearrHttpError extends Error {
  constructor(public status: number | undefined, message: string) {
    super(message);
  }
}

const topMediaCache = new Map<
  string,
  { expires: number; promise: Promise<TracearrTopMediaResult> }
>();

export const clampTracearrDays = (days: number): number => {
  if (!Number.isFinite(days)) return 30;
  if (days <= 0) return TRACEARR_MAX_DAYS;
  return Math.min(TRACEARR_MAX_DAYS, Math.max(1, Math.floor(days)));
};

class TracearrAPI {
  private axios: AxiosInstance;
  private baseURL: string;
  private serverId?: string;
  private keyHash: string;
  private sleep: (ms: number) => Promise<void>;

  constructor(
    settings: TracearrSettings,
    sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {
    const protocol = settings.useSsl ? 'https' : 'http';
    const port = settings.port ? `:${settings.port}` : '';
    const urlBase = settings.urlBase ?? '';

    this.baseURL = `${protocol}://${settings.hostname}${port}${urlBase}`;
    this.serverId = settings.serverId || undefined;
    this.sleep = sleep;
    this.keyHash = createHash('sha256')
      .update(settings.apiKey ?? '')
      .digest('hex')
      .slice(0, 12);
    this.axios = axios.create({
      baseURL: `${this.baseURL}/api/v2/public`,
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      timeout: 30000,
    });
  }

  private async get<T>(
    path: string,
    params?: Record<string, string | number>
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await this.axios.get<T>(path, { params })).data;
      } catch (e) {
        const status = e.response?.status;
        if (status === 429 && attempt < RATE_LIMIT_RETRIES) {
          const retryAfter = Number(e.response?.headers?.['retry-after']);
          const waitMs = Math.min(
            MAX_RETRY_WAIT_MS,
            (Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter
              : 2 ** attempt) * 1000
          );
          logger.warn('Tracearr rate limit hit, retrying', {
            label: 'Tracearr API',
            path,
            waitMs,
          });
          await this.sleep(waitMs);
          continue;
        }
        throw new TracearrHttpError(
          status,
          `[Tracearr] ${path} failed${status ? ` (HTTP ${status})` : ''}: ${
            e.message
          }`
        );
      }
    }
  }

  public async getServers(): Promise<{
    servers: TracearrServer[];
    version?: string;
  }> {
    const body = await this.get<{
      data: TracearrServer[];
      tracearr_version?: string;
    }>('/servers');
    return { servers: body.data, version: body.tracearr_version };
  }

  public async getMedia(ref: string): Promise<TracearrMedia> {
    return this.get<TracearrMedia>(`/media/${encodeURIComponent(ref)}`);
  }

  public getTopMedia(
    options: TopMediaOptions
  ): Promise<TracearrTopMediaResult> {
    const days = clampTracearrDays(options.days);
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const key = [
      this.baseURL,
      this.keyHash,
      this.serverId ?? '',
      options.mediaType,
      days,
      options.sort,
      maxPages,
      options.minViewers ?? '',
    ].join('|');

    const now = Date.now();
    const hit = topMediaCache.get(key);
    if (!options.bypassCache && hit && hit.expires > now) {
      return hit.promise;
    }
    for (const [k, v] of topMediaCache) {
      if (v.expires <= now) topMediaCache.delete(k);
    }

    const promise = this.fetchTopMedia(options, days, maxPages);
    topMediaCache.set(key, { expires: now + CACHE_TTL_MS, promise });
    promise.catch(() => {
      if (topMediaCache.get(key)?.promise === promise) {
        topMediaCache.delete(key);
      }
    });
    return promise;
  }

  private async fetchTopMedia(
    options: TopMediaOptions,
    days: number,
    maxPages: number
  ): Promise<TracearrTopMediaResult> {
    const rows: TracearrTopMediaRow[] = [];
    let cursor: string | null = null;
    let truncated = false;

    for (let page = 0; page < maxPages; page++) {
      const params: Record<string, string | number> = {
        media_type: options.mediaType,
        days,
        sort: options.sort,
        pageSize: PAGE_SIZE,
      };
      if (this.serverId) params.server_id = this.serverId;
      if (cursor) params.cursor = cursor;

      const body: {
        data: TracearrTopMediaRow[];
        meta?: { nextCursor?: string | null };
      } = await this.get('/top-media', params);

      rows.push(...body.data);
      cursor = body.meta?.nextCursor ?? null;
      if (!cursor || body.data.length === 0) break;
      if (
        options.minViewers !== undefined &&
        body.data[body.data.length - 1].unique_users < options.minViewers
      ) {
        break;
      }
      if (page === maxPages - 1) truncated = true;
    }

    if (truncated) {
      logger.warn('Tracearr top-media paging cap reached', {
        label: 'Tracearr API',
        mediaType: options.mediaType,
        days,
        rows: rows.length,
      });
    }

    return { rows, truncated };
  }
}

export default TracearrAPI;

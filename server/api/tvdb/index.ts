import ExternalAPI from '@server/api/externalapi';
import cacheManager from '@server/lib/cache';
import logger from '@server/logger';
import axios from 'axios';
import type {
  TvdbDataResponse,
  TvdbListBase,
  TvdbListExtended,
  TvdbLoginResponse,
  TvdbRemoteId,
  TvdbRemoteIdsRecord,
  TvdbSeriesData,
  TvdbSeriesResponse,
} from './interfaces';

const TVDB_BASE_URL = 'https://api4.thetvdb.com/v4';
const TVDB_API_KEY = '031c39c2-1777-42fb-9da6-c80ba1d6d10c';

// Module-level token cache (~29-day TTL)
const TOKEN_TTL_MS = 29 * 24 * 60 * 60 * 1000;
let tokenCache: { token: string; expiresAt: number } | undefined;

export interface TvdbEntityInfo {
  tmdbId?: number;
  name: string;
  year?: number;
}

export type TvdbListRef = { id: number } | { slug: string };

const TVDB_TMDB_SOURCE = /themoviedb/i;

// Lenient on purpose (bare id/slug accepted); the form and route validation require a full thetvdb.com URL.
export function parseTvdbListInput(input: string): TvdbListRef | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let segment: string | undefined;
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (!/(^|\.)thetvdb\.com$/i.test(url.hostname)) return null;
    segment = url.pathname.match(/^\/lists\/([^/]+)/i)?.[1];
  } else {
    segment = trimmed.replace(/^\/?lists\//i, '').split(/[/?#]/)[0];
  }

  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  return /^\d+$/.test(segment)
    ? { id: Number(segment) }
    : { slug: segment.toLowerCase() };
}

export function extractTvdbTmdbId(
  remoteIds: TvdbRemoteId[] | null | undefined
): number | undefined {
  const match = remoteIds?.find((r) => TVDB_TMDB_SOURCE.test(r.sourceName));
  const id = match ? Number(match.id) : NaN;
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

class TvdbAPI extends ExternalAPI {
  constructor() {
    super(
      TVDB_BASE_URL,
      {},
      {
        nodeCache: cacheManager.getCache('tvdb').data,
      }
    );
  }

  /**
   * Get (or refresh) the TVDB JWT auth token.
   * Uses a fresh axios instance to avoid interceptor loops.
   */
  private async getAuthToken(): Promise<string> {
    const now = Date.now();

    if (tokenCache && now < tokenCache.expiresAt) {
      return tokenCache.token;
    }

    logger.debug('Fetching new TVDB auth token', { label: 'TvdbAPI' });

    const loginAxios = axios.create({
      baseURL: TVDB_BASE_URL,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });

    const response = await loginAxios.post<TvdbLoginResponse>('/login', {
      apikey: TVDB_API_KEY,
    });

    tokenCache = {
      token: response.data.data.token,
      expiresAt: now + TOKEN_TTL_MS,
    };

    logger.debug('TVDB auth token acquired', { label: 'TvdbAPI' });

    return tokenCache.token;
  }

  /**
   * Get series details from TVDB by ID.
   * Response is cached for 1 hour (3600 seconds).
   */
  public async getSeriesById(tvdbId: number): Promise<TvdbSeriesData> {
    const token = await this.getAuthToken();

    const data = await this.get<TvdbSeriesResponse>(
      `/series/${tvdbId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      3600
    );

    return data.data;
  }

  private async authedGet<T>(endpoint: string, ttl: number): Promise<T> {
    const token = await this.getAuthToken();
    return this.get<T>(
      endpoint,
      { headers: { Authorization: `Bearer ${token}` } },
      ttl
    );
  }

  public async getList(ref: TvdbListRef): Promise<TvdbListExtended> {
    let id: number;
    if ('id' in ref) {
      id = ref.id;
    } else {
      const base = await this.authedGet<TvdbDataResponse<TvdbListBase>>(
        `/lists/slug/${encodeURIComponent(ref.slug)}`,
        3600
      );
      id = base.data.id;
    }
    const extended = await this.authedGet<TvdbDataResponse<TvdbListExtended>>(
      `/lists/${id}/extended`,
      300
    );
    return extended.data;
  }

  public async getEntityInfo(
    kind: 'movie' | 'series',
    tvdbId: number
  ): Promise<TvdbEntityInfo> {
    const path = kind === 'movie' ? 'movies' : 'series';
    const record = await this.authedGet<TvdbDataResponse<TvdbRemoteIdsRecord>>(
      `/${path}/${tvdbId}/extended?short=true`,
      86400
    );
    const year = Number(record.data.year);
    return {
      tmdbId: extractTvdbTmdbId(record.data.remoteIds),
      name: record.data.name,
      year: Number.isInteger(year) && year > 0 ? year : undefined,
    };
  }
}

export default TvdbAPI;

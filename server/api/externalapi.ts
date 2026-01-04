import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import axios from 'axios';
import rateLimit from 'axios-rate-limit';
import type NodeCache from 'node-cache';
import logger from '@server/logger';

// 5 minute default TTL (in seconds)
const DEFAULT_TTL = 300;

// 10 seconds default rolling buffer (in ms)
const DEFAULT_ROLLING_BUFFER = 10000;

// 7 day TTL for stale cache fallback (in seconds)
const STALE_CACHE_TTL = 86400 * 7;

interface ExternalAPIOptions {
  nodeCache?: NodeCache;
  staleCache?: NodeCache;
  headers?: Record<string, unknown>;
  rateLimit?: {
    maxRPS: number;
    maxRequests: number;
  };
}

class ExternalAPI {
  protected axios: AxiosInstance;
  private baseUrl: string;
  protected cache?: NodeCache;
  // Secondary cache with longer TTL for stale-while-revalidate fallback
  protected staleCache?: NodeCache;

  constructor(
    baseUrl: string,
    params: Record<string, unknown>,
    options: ExternalAPIOptions = {}
  ) {
    this.axios = axios.create({
      baseURL: baseUrl,
      params,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...options.headers,
      },
    });

    if (options.rateLimit) {
      this.axios = rateLimit(this.axios, {
        maxRequests: options.rateLimit.maxRequests,
        maxRPS: options.rateLimit.maxRPS,
      });
    }

    this.baseUrl = baseUrl;
    this.cache = options.nodeCache;
    this.staleCache = options.staleCache;
  }

  protected async get<T>(
    endpoint: string,
    config?: AxiosRequestConfig,
    ttl?: number
  ): Promise<T> {
    const cacheKey = this.serializeCacheKey(endpoint, config?.params);
    const cachedItem = this.cache?.get<T>(cacheKey);
    if (cachedItem) {
      return cachedItem;
    }

    try {
      const response = await this.axios.get<T>(endpoint, config);

      if (this.cache) {
        this.cache.set(cacheKey, response.data, ttl ?? DEFAULT_TTL);
      }
      // Store in stale cache with longer TTL for fallback
      if (this.staleCache) {
        this.staleCache.set(cacheKey, response.data, STALE_CACHE_TTL);
      }

      return response.data;
    } catch (error) {
      // On API failure, try to return stale cached data
      const staleItem = this.staleCache?.get<T>(cacheKey);
      if (staleItem) {
        logger.warn(
          `API request failed, serving stale cached data for: ${endpoint}`,
          { label: 'ExternalAPI' }
        );
        return staleItem;
      }
      throw error;
    }
  }

  protected async post<T>(
    endpoint: string,
    data: Record<string, unknown>,
    config?: AxiosRequestConfig,
    ttl?: number
  ): Promise<T> {
    const cacheKey = this.serializeCacheKey(endpoint, {
      config: config?.params,
      data,
    });
    const cachedItem = this.cache?.get<T>(cacheKey);
    if (cachedItem) {
      return cachedItem;
    }

    try {
      const response = await this.axios.post<T>(endpoint, data, config);

      if (this.cache) {
        this.cache.set(cacheKey, response.data, ttl ?? DEFAULT_TTL);
      }
      // Store in stale cache with longer TTL for fallback
      if (this.staleCache) {
        this.staleCache.set(cacheKey, response.data, STALE_CACHE_TTL);
      }

      return response.data;
    } catch (error) {
      // On API failure, try to return stale cached data
      const staleItem = this.staleCache?.get<T>(cacheKey);
      if (staleItem) {
        logger.warn(
          `API request failed, serving stale cached data for: ${endpoint}`,
          { label: 'ExternalAPI' }
        );
        return staleItem;
      }
      throw error;
    }
  }

  protected async getRolling<T>(
    endpoint: string,
    config?: AxiosRequestConfig,
    ttl?: number
  ): Promise<T> {
    const cacheKey = this.serializeCacheKey(endpoint, config?.params);
    const cachedItem = this.cache?.get<T>(cacheKey);

    if (cachedItem) {
      const keyTtl = this.cache?.getTtl(cacheKey) ?? 0;

      // If the item has passed our rolling check, fetch again in background
      if (
        keyTtl - (ttl ?? DEFAULT_TTL) * 1000 <
        Date.now() - DEFAULT_ROLLING_BUFFER
      ) {
        this.axios
          .get<T>(endpoint, config)
          .then((response) => {
            this.cache?.set(cacheKey, response.data, ttl ?? DEFAULT_TTL);
            this.staleCache?.set(cacheKey, response.data, STALE_CACHE_TTL);
          })
          .catch((error) => {
            // Log but don't throw - this is a background refresh, stale cache is acceptable
            logger.warn('Rolling cache background refresh failed', {
              label: 'ExternalAPI',
              endpoint,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
      return cachedItem;
    }

    try {
      const response = await this.axios.get<T>(endpoint, config);

      if (this.cache) {
        this.cache.set(cacheKey, response.data, ttl ?? DEFAULT_TTL);
      }
      if (this.staleCache) {
        this.staleCache.set(cacheKey, response.data, STALE_CACHE_TTL);
      }

      return response.data;
    } catch (error) {
      // On API failure, try to return stale cached data
      const staleItem = this.staleCache?.get<T>(cacheKey);
      if (staleItem) {
        logger.warn(
          `API request failed, serving stale cached data for: ${endpoint}`,
          { label: 'ExternalAPI' }
        );
        return staleItem;
      }
      throw error;
    }
  }

  private serializeCacheKey(
    endpoint: string,
    params?: Record<string, unknown>
  ) {
    if (!params) {
      return `${this.baseUrl}${endpoint}`;
    }

    return `${this.baseUrl}${endpoint}${JSON.stringify(params)}`;
  }
}

export default ExternalAPI;

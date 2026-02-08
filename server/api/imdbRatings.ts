import ExternalAPI from '@server/api/externalapi';
import cacheManager from '@server/lib/cache';
import logger from '@server/logger';

/**
 * IMDb Rating Response from Agregarr API
 */
export interface ImdbRatingResponse {
  imdbId: string;
  rating: number | null;
  votes: number | null;
}

/**
 * IMDb Ratings API client for fetching ratings from Agregarr's IMDb proxy
 *
 * This API supports both Movies and TV Shows.
 * API Documentation: https://api.agregarr.org
 */
class ImdbRatingsAPI extends ExternalAPI {
  constructor() {
    super(
      'https://api.agregarr.org',
      {}, // URL params
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        nodeCache: cacheManager.getCache('imdb').data,
      }
    );
  }

  /**
   * Fetch a single batch with retry logic and exponential backoff
   * @param batch - Array of IMDb IDs (max 100)
   * @param batchNum - Current batch number (for logging)
   * @param totalBatches - Total number of batches (for logging)
   * @param maxRetries - Maximum retry attempts (default: 3)
   */
  private async fetchBatchWithRetry(
    batch: string[],
    batchNum: number,
    totalBatches: number,
    maxRetries = 3
  ): Promise<ImdbRatingResponse[]> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Build query string with multiple id parameters
        const queryParams = batch.map((id) => `id=${encodeURIComponent(id)}`);
        const url = `/api/ratings?${queryParams.join('&')}`;

        const response = await this.get<ImdbRatingResponse[]>(
          url,
          undefined,
          30000
        );

        if (attempt > 0) {
          logger.info(
            `IMDb batch ${batchNum}/${totalBatches} succeeded on retry ${attempt}`,
            { label: 'IMDb Ratings API' }
          );
        }

        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Only retry on transient errors (5xx, rate limits, network errors)
        const isTransient =
          lastError.message.includes('status code 5') || // 500, 502, 503, 504, 522, etc.
          lastError.message.includes('429') || // Rate limited
          lastError.message.includes('ECONNRESET') ||
          lastError.message.includes('ETIMEDOUT') ||
          lastError.message.includes('ECONNREFUSED') ||
          lastError.message.includes('socket hang up');

        if (!isTransient || attempt === maxRetries) {
          logger.error(
            `IMDb batch ${batchNum}/${totalBatches} failed after ${
              attempt + 1
            } attempts`,
            {
              label: 'IMDb Ratings API',
              error: lastError.message,
              batchSize: batch.length,
              willRetry: false,
            }
          );
          throw lastError;
        }

        // Exponential backoff with jitter: 1-1.5s, 2-3s, 4-6s
        const baseDelay = 1000 * Math.pow(2, attempt);
        const jitter = baseDelay * (0.5 * Math.random()); // 0-50% jitter
        const delayMs = Math.round(baseDelay + jitter);
        logger.warn(
          `IMDb batch ${batchNum}/${totalBatches} failed, retrying in ${delayMs}ms`,
          {
            label: 'IMDb Ratings API',
            attempt: attempt + 1,
            maxRetries,
            error: lastError.message,
          }
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    // Should never reach here, but TypeScript needs it
    throw lastError || new Error('Unknown error in fetchBatchWithRetry');
  }

  /**
   * Get ratings for one or more IMDb IDs
   *
   * @param imdbIds - Single IMDb ID or array of IMDb IDs (max 100 per request)
   * @returns Array of rating responses
   */
  public async getRatings(
    imdbIds: string | string[]
  ): Promise<ImdbRatingResponse[]> {
    try {
      const ids = Array.isArray(imdbIds) ? imdbIds : [imdbIds];

      if (ids.length === 0) {
        return [];
      }

      if (ids.length > 100) {
        logger.info(`Fetching ${ids.length} IMDb ratings in batches of 100`, {
          label: 'IMDb Ratings API',
          requestedCount: ids.length,
          batchCount: Math.ceil(ids.length / 100),
        });

        // Split into batches of 100
        const batches: string[][] = [];
        for (let i = 0; i < ids.length; i += 100) {
          batches.push(ids.slice(i, i + 100));
        }

        // Fetch all batches with retry logic and partial success handling
        const allResults: ImdbRatingResponse[] = [];
        let successCount = 0;
        let failedCount = 0;

        // Process batches with concurrency limit to avoid overwhelming the API
        const CONCURRENT_BATCHES = 5;
        for (let i = 0; i < batches.length; i += CONCURRENT_BATCHES) {
          const batchSlice = batches.slice(i, i + CONCURRENT_BATCHES);
          const batchPromises = batchSlice.map((batch, idx) =>
            this.fetchBatchWithRetry(batch, i + idx + 1, batches.length)
          );

          const results = await Promise.allSettled(batchPromises);

          for (const result of results) {
            if (result.status === 'fulfilled') {
              allResults.push(...result.value);
              successCount++;
            } else {
              failedCount++;
            }
          }
        }

        if (failedCount > 0) {
          logger.warn(`IMDb batch prefetch completed with partial success`, {
            label: 'IMDb Ratings API',
            successfulBatches: successCount,
            failedBatches: failedCount,
            totalBatches: batches.length,
            ratingsRetrieved: allResults.length,
            ratingsRequested: ids.length,
          });
        } else {
          logger.info(`IMDb batch prefetch completed successfully`, {
            label: 'IMDb Ratings API',
            batches: batches.length,
            ratingsRetrieved: allResults.length,
          });
        }

        return allResults;
      }

      // Single batch (≤100 ids) - use same retry logic for consistency
      const response = await this.fetchBatchWithRetry(ids, 1, 1);

      logger.debug(`Fetched ${response.length} IMDb ratings`, {
        label: 'IMDb Ratings API',
        requestedCount: ids.length,
        receivedCount: response.length,
      });

      return response;
    } catch (error) {
      logger.error('Failed to fetch IMDb ratings:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        imdbIds: Array.isArray(imdbIds) ? imdbIds.length : 1,
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw new Error(
        `Failed to retrieve IMDb ratings: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Get rating for a single IMDb ID
   *
   * @param imdbId - IMDb ID (e.g., "tt0111161")
   * @returns Rating response or null if not found
   */
  public async getRating(imdbId: string): Promise<ImdbRatingResponse | null> {
    try {
      const results = await this.getRatings(imdbId);
      return results.length > 0 ? results[0] : null;
    } catch (error) {
      logger.error(`Failed to fetch IMDb rating for ${imdbId}:`, {
        error: error instanceof Error ? error.message : 'Unknown error',
        imdbId,
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * Check API health status
   *
   * @returns Health status information
   */
  public async getHealth(): Promise<{
    status: string;
    lastUpdate: string;
    totalRatings: number;
    uptime: number;
  }> {
    try {
      return await this.get('/api/health', undefined, 10000);
    } catch (error) {
      logger.error('Failed to fetch IMDb Ratings API health:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw new Error(
        `Failed to check API health: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }
}

export default ImdbRatingsAPI;

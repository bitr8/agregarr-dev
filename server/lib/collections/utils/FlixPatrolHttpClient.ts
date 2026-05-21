import logger from '@server/logger';
import axios, { type AxiosInstance } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';

export class FlixPatrolHttpClient {
  private static instance: AxiosInstance | null = null;
  private static cookieJar: CookieJar | null = null;
  private static isInitialized = false;

  private static initialize(): void {
    if (this.isInitialized) {
      return;
    }

    this.cookieJar = new CookieJar();

    this.instance = wrapper(
      axios.create({
        jar: this.cookieJar,
        withCredentials: true,
        timeout: 15000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'max-age=0',
          Connection: 'keep-alive',
        },
      })
    );

    this.isInitialized = true;

    logger.debug('FlixPatrol HTTP client initialized', {
      label: 'FlixPatrol HTTP',
    });
  }

  static async fetchPage(url: string): Promise<string> {
    if (!this.isInitialized) {
      this.initialize();
    }

    if (!this.instance) {
      throw new Error('Failed to initialize FlixPatrol HTTP client');
    }

    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.instance.get<string>(url, {
          responseType: 'text',
        });

        const html = response.data;
        if (
          response.status === 403 ||
          (html.includes('cf-challenge') && html.includes('cloudflare'))
        ) {
          throw new Error('Cloudflare challenge detected');
        }

        return html;
      } catch (error) {
        const isCloudflare =
          error instanceof Error &&
          error.message === 'Cloudflare challenge detected';
        const is403or503 =
          axios.isAxiosError(error) &&
          (error.response?.status === 403 || error.response?.status === 503);

        if ((isCloudflare || is403or503) && attempt < maxRetries) {
          const delay = 1000 * Math.pow(2, attempt);
          logger.warn(
            `FlixPatrol HTTP blocked (attempt ${attempt + 1}/${
              maxRetries + 1
            }), retrying in ${delay}ms`,
            {
              label: 'FlixPatrol HTTP',
              url,
              status: axios.isAxiosError(error)
                ? error.response?.status
                : 'challenge',
            }
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        const message = error instanceof Error ? error.message : String(error);
        logger.error(`FlixPatrol HTTP fetch failed: ${message}`, {
          label: 'FlixPatrol HTTP',
          url,
          attempts: attempt + 1,
        });
        throw error;
      }
    }

    throw new Error('FlixPatrol HTTP fetch exhausted retries');
  }

  static reset(): void {
    this.isInitialized = false;
    this.instance = null;
    this.cookieJar = null;

    logger.debug('FlixPatrol HTTP client reset', {
      label: 'FlixPatrol HTTP',
    });
  }
}

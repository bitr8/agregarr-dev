import logger from '@server/logger';
import axios, { type AxiosInstance } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';

/**
 * Letterboxd HTTP Client - Plain axios alternative to Playwright/CloudflareSolver
 *
 * Uses the same singleton + cookie jar pattern as ImdbAxiosClient.
 * Letterboxd pages return full HTML without JavaScript rendering,
 * so a plain HTTP client with browser-like headers is sufficient.
 */
export class LetterboxdHttpClient {
  private static instance: AxiosInstance | null = null;
  private static cookieJar: CookieJar | null = null;
  private static isInitialized = false;
  private static lastChallengeDetected: Date | null = null;

  static getLastChallengeDetected(): Date | null {
    return this.lastChallengeDetected;
  }

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

    logger.debug('Letterboxd HTTP client initialized', {
      label: 'Letterboxd HTTP',
    });
  }

  /**
   * Fetch a page and return its HTML content.
   * Same interface as CloudflareSolver.fetchPage() for drop-in replacement.
   */
  static async fetchPage(url: string): Promise<string> {
    if (!this.isInitialized) {
      this.initialize();
    }

    if (!this.instance) {
      throw new Error('Failed to initialize Letterboxd HTTP client');
    }

    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.instance.get<string>(url, {
          responseType: 'text',
        });

        // Detect Cloudflare challenge pages
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
            `Letterboxd HTTP blocked (attempt ${attempt + 1}/${
              maxRetries + 1
            }), retrying in ${delay}ms`,
            {
              label: 'Letterboxd HTTP',
              url,
              status: axios.isAxiosError(error)
                ? error.response?.status
                : 'challenge',
            }
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // Final failure - let caller handle it
        if (isCloudflare || is403or503) {
          this.lastChallengeDetected = new Date();
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Letterboxd HTTP fetch failed: ${message}`, {
          label: 'Letterboxd HTTP',
          url,
          attempts: attempt + 1,
        });
        throw error;
      }
    }

    // Should not reach here, but TypeScript needs it
    throw new Error('Letterboxd HTTP fetch exhausted retries');
  }

  /**
   * Reset the client (clears cookies and forces reinitialization)
   */
  static reset(): void {
    this.isInitialized = false;
    this.instance = null;
    this.cookieJar = null;

    logger.debug('Letterboxd HTTP client reset', {
      label: 'Letterboxd HTTP',
    });
  }
}

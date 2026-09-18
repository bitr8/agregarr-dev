import type { CloudflareSolverInstance } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { AxiosResponse } from 'axios';
import axios from 'axios';
import { chromium, type BrowserContext } from 'playwright';

/**
 * Cloudflare Challenge Solver
 *
 * When cloudflareSolvers are configured, delegates to FlareSolverr-protocol
 * sidecars (FlareSolverr/Byparr), trying entries in priority order. Otherwise
 * falls back to built-in Playwright headless browser.
 */
interface FlareSolverrErrorResponse {
  response?: { status?: number; data?: { message?: string } };
}

function isChallengeTitle(title: string): boolean {
  return (
    title.includes('Just a moment') ||
    title.includes('Checking your browser') ||
    title === ''
  );
}

function isChallengeHtml(html: string): boolean {
  return (
    html.includes('<title>Just a moment') ||
    html.includes('<title>Checking your browser') ||
    html.includes('<title></title>')
  );
}

export class CloudflareSolver {
  private static fetchInProgress: Map<string, Promise<string>> = new Map();
  private static htmlCache: Map<string, { html: string; fetchedAt: number }> =
    new Map();
  private static readonly HTML_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private static readonly BACKOFF_BASE_MS = 60 * 1000; // 1 minute
  // Failures further apart than this are not consecutive
  private static readonly FAILURE_MEMORY_MS = 20 * 60 * 1000;
  private static solveFailures: Map<
    string,
    { count: number; backoffUntil: number }
  > = new Map();

  // Cookie/UA captured from a solved page, reused for plain-axios asset fetches.
  private static readonly SESSION_TTL = 30 * 60 * 1000; // 30 minutes
  private static domainSessions: Map<
    string,
    { cookieHeader: string; userAgent: string; fetchedAt: number }
  > = new Map();

  // Backoff is per solver instance (URL) + domain, so one dead instance
  // doesn't block the others. Playwright uses the literal key 'playwright'.
  // ponytail: edited-away solver URLs orphan their entries for process
  // lifetime; bounded by distinct URLs ever configured — sweep if it matters.
  private static backoffKey(domain: string, instance: string): string {
    return `${instance}:${domain}`;
  }

  private static getSolvers(): CloudflareSolverInstance[] {
    return (getSettings().main.cloudflareSolvers ?? []).filter((s) => s?.url);
  }

  /**
   * Fetch page content, bypassing Cloudflare.
   * Results are cached for 5 minutes — the same URL is often requested
   * multiple times in quick succession (validate → extractTitle → page 1 fetch).
   */
  static async fetchPage(url: string): Promise<string> {
    // Return cached content if still fresh (before backoff — cached data is valid)
    const cached = this.htmlCache.get(url);
    if (cached && Date.now() - cached.fetchedAt < this.HTML_CACHE_TTL) {
      return cached.html;
    }

    // Join in-flight fetch (before backoff — someone already started this)
    const inProgress = this.fetchInProgress.get(url);
    if (inProgress) {
      return await inProgress;
    }

    const fetchPromise = this.fetchUncached(url);
    this.fetchInProgress.set(url, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      this.fetchInProgress.delete(url);
    }
  }

  /**
   * Walk configured solvers in priority order; first success wins.
   * No Playwright fallback when solvers are configured — an outage
   * surfaces in the health check, not a silent slow fallback.
   */
  private static async fetchUncached(url: string): Promise<string> {
    const domain = new URL(url).hostname;
    const solvers = this.getSolvers();

    if (!solvers.length) {
      return this.attemptFetch(url, domain, 'playwright', () =>
        this.fetchWithBrowser(url)
      );
    }

    const failures: string[] = [];
    for (const solver of solvers) {
      try {
        return await this.attemptFetch(url, domain, solver.url, () =>
          this.fetchWithFlareSolverr(url, solver.url)
        );
      } catch (error) {
        failures.push(
          `${solver.name || solver.url}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    throw new Error(
      `All ${
        solvers.length
      } Cloudflare solver(s) failed for ${domain}: ${failures.join('; ')}`
    );
  }

  /**
   * Run one solve attempt with backoff bookkeeping for the given instance.
   */
  private static async attemptFetch(
    url: string,
    domain: string,
    instance: string,
    fetch: () => Promise<string>
  ): Promise<string> {
    const failureKey = this.backoffKey(domain, instance);
    const failure = this.solveFailures.get(failureKey);
    if (failure && failure.backoffUntil > Date.now()) {
      const waitSecs = Math.round((failure.backoffUntil - Date.now()) / 1000);
      throw new Error(
        `backing off for ${domain} (${failure.count} consecutive failures, ${waitSecs}s remaining)`
      );
    }

    try {
      const content = await fetch();
      if (!isChallengeHtml(content)) {
        this.htmlCache.set(url, { html: content, fetchedAt: Date.now() });
      }
      this.solveFailures.delete(failureKey);
      return content;
    } catch (error) {
      const prev = this.solveFailures.get(failureKey);
      const stale =
        prev && Date.now() - prev.backoffUntil > this.FAILURE_MEMORY_MS;
      const count = stale ? 1 : (prev?.count ?? 0) + 1;
      // First failure is free: one slow solve must not fail every fetch behind it
      const backoffMs =
        count < 2
          ? 0
          : this.BACKOFF_BASE_MS * Math.pow(2, Math.min(count - 2, 4));
      this.solveFailures.set(failureKey, {
        count,
        backoffUntil: Date.now() + backoffMs,
      });
      logger.warn(
        `Cloudflare solve failed for ${domain} via ${instance} (${count} consecutive), ${
          backoffMs
            ? `backoff ${Math.round(backoffMs / 1000)}s`
            : 'retrying on next request'
        }`,
        { label: 'Cloudflare Solver' }
      );
      throw error;
    }
  }

  /**
   * Fetch page content using Playwright browser
   */
  private static async fetchWithBrowser(url: string): Promise<string> {
    const domain = new URL(url).hostname;

    logger.info('Fetching page with Playwright (Cloudflare bypass)', {
      label: 'Cloudflare Solver',
      domain,
      url,
    });

    let context: BrowserContext | null = null;

    try {
      // Use system Chromium if configured (Docker/Alpine), otherwise use Playwright's
      const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

      const browser = await chromium.launch({
        headless: true,
        executablePath: executablePath || undefined,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--disable-setuid-sandbox',
        ],
      });

      context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        },
      });

      const page = await context.newPage();

      // Add stealth measures to avoid detection
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
        });

        (window as Window & { chrome?: object }).chrome = {
          runtime: {},
        };

        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5],
        });

        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en'],
        });
      });

      logger.debug('Navigating to URL', {
        label: 'Cloudflare Solver',
        url,
      });

      // Navigate and wait for content to load
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      const status = response?.status();
      logger.debug('Response received', {
        label: 'Cloudflare Solver',
        status,
      });

      // If we got a challenge page, wait for it to resolve
      const maxWaitTime = 30000;
      const pollInterval = 500;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitTime) {
        const pageTitle = await page.title();

        if (!isChallengeTitle(pageTitle)) {
          logger.debug('Page loaded successfully', {
            label: 'Cloudflare Solver',
            pageTitle,
            elapsedMs: Date.now() - startTime,
          });
          break;
        }

        logger.debug('Waiting for challenge to complete...', {
          label: 'Cloudflare Solver',
          pageTitle,
          elapsedMs: Date.now() - startTime,
        });

        await page.waitForTimeout(pollInterval);
      }

      const finalTitle = await page.title();
      if (isChallengeTitle(finalTitle)) {
        await browser.close();
        throw new Error(
          `Cloudflare challenge did not resolve within ${maxWaitTime}ms for ${domain}`
        );
      }

      // Get the page content
      const content = await page.content();

      logger.info('Successfully fetched page content', {
        label: 'Cloudflare Solver',
        domain,
        contentLength: content.length,
      });

      await browser.close();

      return content;
    } catch (error) {
      logger.error('Failed to fetch page with Playwright', {
        label: 'Cloudflare Solver',
        domain,
        error: error instanceof Error ? error.message : String(error),
      });

      if (context) {
        await context.browser()?.close();
      }

      throw new Error(
        `Failed to fetch ${domain} page: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Fetch page via FlareSolverr sidecar (same API as Prowlarr/Jackett).
   */
  private static async fetchWithFlareSolverr(
    url: string,
    solverrUrl: string
  ): Promise<string> {
    const domain = new URL(url).hostname;

    logger.info('Fetching page via FlareSolverr', {
      label: 'Cloudflare Solver',
      domain,
      url,
    });

    const endpoint = solverrUrl.replace(/\/+$/, '') + '/v1';
    let response;
    try {
      response = await axios.post(
        endpoint,
        { cmd: 'request.get', url, maxTimeout: 60000 },
        { timeout: 70000 }
      );
    } catch (error) {
      const fsResponse = (error as FlareSolverrErrorResponse).response;
      const fsMessage = fsResponse?.data?.message;
      const fallback = error instanceof Error ? error.message : String(error);
      throw new Error(
        fsMessage
          ? `FlareSolverr ${fsResponse?.status}: ${fsMessage}`
          : fallback
      );
    }

    if (response.data?.status !== 'ok' || !response.data?.solution?.response) {
      throw new Error(
        `FlareSolverr returned status: ${
          response.data?.status ?? 'unknown'
        } for ${domain}`
      );
    }

    const solutionStatus = (response.data.solution.status as number) ?? 0;
    if (solutionStatus >= 400) {
      throw new Error(
        `FlareSolverr upstream returned HTTP ${solutionStatus} for ${domain}`
      );
    }

    const html = response.data.solution.response as string;

    if (isChallengeHtml(html)) {
      throw new Error(
        `FlareSolverr could not solve Cloudflare challenge for ${domain}`
      );
    }

    const cookies = response.data.solution.cookies as
      | { name: string; value: string }[]
      | undefined;
    const userAgent = response.data.solution.userAgent as string | undefined;
    if (cookies?.length && userAgent) {
      this.domainSessions.set(domain, {
        cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
        userAgent,
        fetchedAt: Date.now(),
      });
    }

    logger.info('Successfully fetched page via FlareSolverr', {
      label: 'Cloudflare Solver',
      domain,
      contentLength: html.length,
    });

    return html;
  }

  private static getSession(domain: string) {
    const session = this.domainSessions.get(domain);
    if (session && Date.now() - session.fetchedAt < this.SESSION_TTL) {
      return session;
    }
    return null;
  }

  private static sessionHeaders(
    domain: string
  ): Record<string, string> | undefined {
    const session = this.getSession(domain);
    return session
      ? { Cookie: session.cookieHeader, 'User-Agent': session.userAgent }
      : undefined;
  }

  // Forces a fresh solve: fetchPage alone would just serve the 5-minute htmlCache.
  private static async refreshSession(domain: string): Promise<void> {
    const root = `https://${domain}/`;
    this.htmlCache.delete(root);
    await this.fetchPage(root);
  }

  /**
   * Fetch a non-HTML asset (CSS, image) that sits behind the same Cloudflare challenge as the page.
   */
  static async fetchAsset(
    url: string,
    opts: {
      responseType?: 'arraybuffer' | 'text';
      headers?: Record<string, string>;
      timeout?: number;
    } = {}
  ): Promise<AxiosResponse> {
    const domain = new URL(url).hostname;

    if (!this.getSolvers().length) {
      return axios.get(url, opts);
    }

    if (!this.getSession(domain)) {
      // Cache-honouring on purpose: a cookieless solver must not solve per call
      const failed = await this.fetchPage(`https://${domain}/`).then(
        () => undefined,
        (e) => (e instanceof Error ? e.message : String(e))
      );
      if (!this.getSession(domain)) {
        logger.warn(
          failed
            ? `Solver session fetch failed: ${failed}`
            : 'Solver returned no session cookies',
          { label: 'Cloudflare Solver', domain }
        );
      }
    }

    const usedSession = this.getSession(domain);
    try {
      return await axios.get(url, {
        ...opts,
        headers: { ...opts.headers, ...this.sessionHeaders(domain) },
      });
    } catch (error) {
      if (
        !usedSession ||
        (error as { response?: { status?: number } })?.response?.status !== 403
      ) {
        throw error;
      }
      this.domainSessions.delete(domain);
      await this.refreshSession(domain);
      return axios.get(url, {
        ...opts,
        headers: { ...opts.headers, ...this.sessionHeaders(domain) },
      });
    }
  }

  /**
   * Fetch multiple pages using a single shared browser context.
   * More efficient than fetchPage() for batches since browser startup only happens once.
   */
  static async fetchPagesBatch(
    urls: string[],
    concurrency = 5
  ): Promise<Map<string, string>> {
    if (urls.length === 0) return new Map();

    // When solvers are configured, route through fetchPage for backoff/cache.
    // No backoff short-circuit here: fetchPage serves cached pages even when
    // every solver is backing off, and its backoff throw is cheap.
    const solvers = this.getSolvers();
    if (solvers.length) {
      const results = new Map<string, string>();
      for (const url of urls) {
        try {
          const html = await this.fetchPage(url);
          results.set(url, html);
        } catch (error) {
          logger.debug(
            `Solver batch: failed for ${url}: ${
              error instanceof Error ? error.message : 'Unknown'
            }`,
            { label: 'Cloudflare Solver' }
          );
        }
      }
      return results;
    }

    const results = new Map<string, string>();
    const domain = new URL(urls[0]).hostname;

    logger.info(
      `Fetching ${urls.length} pages with shared browser (${concurrency} concurrent)`,
      {
        label: 'Cloudflare Solver',
        domain,
        total: urls.length,
        concurrency,
      }
    );

    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

    const browser = await chromium.launch({
      headless: true,
      executablePath: executablePath || undefined,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });

    try {
      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        },
      });

      // Apply stealth measures once for all pages from this context
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
        });
        (window as Window & { chrome?: object }).chrome = { runtime: {} };
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5],
        });
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en'],
        });
      });

      for (let i = 0; i < urls.length; i += concurrency) {
        const batch = urls.slice(i, i + concurrency);

        const batchResults = await Promise.all(
          batch.map(async (url) => {
            const page = await context.newPage();
            try {
              await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
              });
              const title = await page.title();
              if (isChallengeTitle(title)) {
                logger.warn(
                  `Cloudflare challenge not resolved for batch URL: ${url}`,
                  { label: 'Cloudflare Solver' }
                );
                return { url, content: null };
              }
              const content = await page.content();
              return { url, content };
            } catch (error) {
              logger.debug(
                `Failed to fetch ${url}: ${
                  error instanceof Error ? error.message : 'Unknown'
                }`,
                { label: 'Cloudflare Solver' }
              );
              return { url, content: null };
            } finally {
              await page.close();
            }
          })
        );

        for (const { url, content } of batchResults) {
          if (content) {
            results.set(url, content);
          }
        }

        if (i + concurrency < urls.length) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }

      logger.info(
        `Batch fetch complete: ${results.size}/${urls.length} pages fetched`,
        {
          label: 'Cloudflare Solver',
          domain,
          fetched: results.size,
          total: urls.length,
        }
      );
    } finally {
      await browser.close();
    }

    return results;
  }
}

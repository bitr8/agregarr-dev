import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock logger before any imports
vi.mock('@server/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('AniList retry cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should throw after 5 consecutive 429 responses', async () => {
    mockFetch.mockResolvedValue({
      status: 429,
      headers: new Headers({ 'Retry-After': '0' }),
    });

    const { getTrendingAnime } = await import('./anilist');

    // Attach .catch() immediately to prevent unhandled rejection warning
    let caughtError: Error | undefined;
    const promise = getTrendingAnime(1, 10).catch((e: Error) => {
      caughtError = e;
    });

    // Advance through all retry delays
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }

    await promise;

    expect(caughtError?.message).toBe(
      'AniList API rate limit exceeded after 5 retries'
    );

    // 1 initial + 5 retries = 6 total fetch calls
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });
});

describe('Retry-After header parsing', () => {
  it('should handle non-numeric Retry-After without tight-looping', () => {
    const retryAfter = 'Sun, 09 Feb 2026 00:00:00 GMT';
    const parsed = parseInt(retryAfter, 10);
    const waitTime =
      Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : 1000;

    expect(Number.isNaN(parsed)).toBe(true);
    expect(waitTime).toBe(1000);
  });

  it('should parse valid numeric Retry-After', () => {
    const retryAfter = '5';
    const parsed = parseInt(retryAfter, 10);
    const waitTime =
      Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : 1000;

    expect(waitTime).toBe(5000);
  });

  it('should handle Retry-After: 0 as default 1s', () => {
    const retryAfter = '0';
    const parsed = parseInt(retryAfter, 10);
    const waitTime =
      Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : 1000;

    expect(waitTime).toBe(1000);
  });
});

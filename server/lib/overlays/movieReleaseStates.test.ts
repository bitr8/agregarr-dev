process.env.TZ = 'Australia/Sydney';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetMovie = vi.fn();
vi.mock('@server/api/themoviedb', () => ({
  default: class {
    getMovie = mockGetMovie;
  },
}));

const cacheStore = new Map<string, unknown>();
vi.mock('@server/lib/cache', () => ({
  default: {
    getCache: () => ({
      data: {
        get: (k: string) => cacheStore.get(k),
        set: (k: string, v: unknown) => cacheStore.set(k, v),
      },
    }),
  },
}));

vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    overlays: { watchProviderRegion: 'US' },
    main: { ratingsCacheMaxDays: 30 },
  }),
}));

import { fetchReleaseDateInfo } from './OverlayContextBuilder';
import { overlayLibraryService } from './OverlayLibraryService';
import {
  deriveReleaseDateContext,
  movieReleaseInfoFromTmdb,
  preferRadarrReleaseDate,
} from './releaseDateContext';

const NOW = new Date('2026-07-11T00:00:00.000Z');

const results = [
  {
    iso_3166_1: 'US',
    release_dates: [
      { type: 3, release_date: '2026-03-01T00:00:00.000Z' },
      { type: 4, release_date: '2026-05-10T00:00:00.000Z' },
      { type: 5, release_date: '2026-08-01T00:00:00.000Z' },
    ],
  },
  {
    iso_3166_1: 'GB',
    release_dates: [{ type: 4, release_date: '2026-04-01T00:00:00.000Z' }],
  },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  cacheStore.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('movieReleaseInfoFromTmdb', () => {
  it('keeps each published type, region-preferred', () => {
    expect(movieReleaseInfoFromTmdb(results, 'US')).toEqual({
      releaseDate: '2026-05-10',
      isEstimated: false,
      theatricalRelease: '2026-03-01',
      digitalRelease: '2026-05-10',
      physicalRelease: '2026-08-01',
      releaseSource: 'digital',
    });
  });

  it('labels a theatrical-only movie as an estimate sourced from theatrical', () => {
    const info = movieReleaseInfoFromTmdb(
      [{ iso_3166_1: 'US', release_dates: [results[0].release_dates[0]] }],
      'US'
    );
    expect(info).toMatchObject({
      isEstimated: true,
      releaseSource: 'estimate',
      theatricalRelease: '2026-03-01',
    });
    expect(info?.digitalRelease).toBeUndefined();
  });
});

describe('deriveReleaseDateContext per-type states', () => {
  it('exposes signed days since each type and the home release', () => {
    const info = movieReleaseInfoFromTmdb(results, 'US')!;
    const ctx = deriveReleaseDateContext(info);
    expect(ctx.theatricalReleaseDate).toBe('2026-03-01');
    expect(ctx.digitalReleaseDate).toBe('2026-05-10');
    expect(ctx.daysSinceDigitalRelease).toBe(62);
    expect(ctx.daysSincePhysicalRelease).toBe(-21);
    expect(ctx.daysSinceHomeRelease).toBe(62);
    expect(ctx.releaseDateSource).toBe('digital');
  });

  it('leaves a theatrical-only movie without a home release', () => {
    const ctx = deriveReleaseDateContext({
      releaseDate: '2026-06-01',
      isEstimated: true,
      theatricalRelease: '2026-03-03',
      releaseSource: 'estimate',
    });
    expect(ctx.daysSinceTheatricalRelease).toBe(130);
    expect(ctx.daysSinceHomeRelease).toBeUndefined();
    expect(ctx.digitalReleaseDate).toBeUndefined();
  });

  it('adds nothing for a show', () => {
    const ctx = deriveReleaseDateContext({ releaseDate: '2026-01-01' });
    expect(ctx.releaseDateSource).toBeUndefined();
    expect(ctx.daysSinceHomeRelease).toBeUndefined();
  });
});

describe('placeholder Radarr override keeps the states consistent', () => {
  it('takes digital and physical from Radarr and keeps TMDB theatrical', () => {
    const tmdb = movieReleaseInfoFromTmdb(results, 'US')!;
    const merged = preferRadarrReleaseDate(tmdb, {
      radarrDigitalRelease: '2026-09-01T00:00:00Z',
    })!;
    expect(merged.releaseDate).toBe('2026-09-01');
    expect(merged.digitalRelease).toBe('2026-09-01');
    expect(merged.physicalRelease).toBeUndefined();
    expect(merged.theatricalRelease).toBe('2026-03-01');
    expect(merged.releaseSource).toBe('digital');
  });
});

describe('live producer (overlay-test path)', () => {
  it('returns the per-type dates', async () => {
    mockGetMovie.mockResolvedValue({
      release_dates: { results },
      release_date: '2026-03-01',
    });
    const info = await fetchReleaseDateInfo(9001, 'movie');
    expect(info).toMatchObject({
      digitalRelease: '2026-05-10',
      physicalRelease: '2026-08-01',
      theatricalRelease: '2026-03-01',
      releaseSource: 'digital',
    });
  });
});

describe('prefetch producer (real overlay job path)', () => {
  const plexMovie = (tmdb: number) =>
    ({
      type: 'movie',
      year: 2026,
      Guid: [{ id: `tmdb://${tmdb}` }],
    } as never);

  const prefetch = async (items: unknown[]) => {
    const svc = overlayLibraryService as unknown as {
      prefetchTmdbReleaseDates(i: unknown[]): Promise<void>;
      preloadedTmdbReleaseDates?: Map<string, unknown>;
    };
    svc.preloadedTmdbReleaseDates = undefined;
    await svc.prefetchTmdbReleaseDates(items);
    return svc.preloadedTmdbReleaseDates!;
  };

  it('carries the per-type dates into the context via the preloaded map', async () => {
    mockGetMovie.mockResolvedValue({ release_dates: { results } });
    const preloaded = await prefetch([plexMovie(9002)]);
    expect(preloaded.get('9002:movie')).toMatchObject({
      digitalRelease: '2026-05-10',
      releaseSource: 'digital',
    });
    mockGetMovie.mockClear();
    const info = await fetchReleaseDateInfo(
      9002,
      'movie',
      undefined,
      preloaded as never
    );
    expect(mockGetMovie).not.toHaveBeenCalled();
    const ctx = deriveReleaseDateContext(info!);
    expect(ctx.digitalReleaseDate).toBe('2026-05-10');
    expect(ctx.daysSinceHomeRelease).toBe(62);
    expect(ctx.releaseDateSource).toBe('digital');
  });

  it('serves a current cache entry without refetching', async () => {
    cacheStore.set('9004:movie:US', {
      releaseDate: '2026-05-10',
      isEstimated: false,
      releaseSource: 'digital',
    });
    await prefetch([plexMovie(9004)]);
    expect(mockGetMovie).not.toHaveBeenCalled();
  });
});

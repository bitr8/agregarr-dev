import cacheManager from '@server/lib/cache';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMovieRatings: vi.fn(),
}));

vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({ main: { ratingsCacheMaxDays: 7 } }),
}));
vi.mock('@server/api/themoviedb', () => ({
  default: class {
    getMovie = () => Promise.resolve({ title: 'Test Movie' });
  },
}));
vi.mock('@server/api/rottentomatoes', () => ({
  default: class {
    getMovieRatings = mocks.getMovieRatings;
  },
}));

import { buildRenderContext } from './OverlayContextBuilder';

function movie(tmdbId: number) {
  return {
    ratingKey: String(tmdbId),
    title: 'Test Movie',
    year: 2024,
    Guid: [{ id: `tmdb://${tmdbId}` }],
  } as unknown as Parameters<typeof buildRenderContext>[0];
}

const hotRating = {
  criticsScore: 90,
  audienceScore: 95,
  criticsRating: 'Certified Fresh',
  verifiedHot: true,
};

describe('rtVerifiedHot context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheManager.getCache('rt-ratings').data.flushAll();
    mocks.getMovieRatings.mockResolvedValue(hotRating);
  });

  it('triggers the RT fetch for a template that only uses rtVerifiedHot', async () => {
    await buildRenderContext(
      movie(101),
      'movie',
      false,
      undefined,
      undefined,
      new Set(['rtVerifiedHot'])
    );
    expect(mocks.getMovieRatings).toHaveBeenCalledTimes(1);
  });

  it('sets rtVerifiedHot on a fresh fetch', async () => {
    const { context } = await buildRenderContext(
      movie(102),
      'movie',
      false,
      undefined,
      undefined,
      new Set(['rtCriticsScore', 'rtVerifiedHot'])
    );
    expect(context.rtVerifiedHot).toBe(true);
  });

  it('sets rtVerifiedHot when joining an in-flight request', async () => {
    let release!: (value: typeof hotRating) => void;
    mocks.getMovieRatings.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const fields = new Set(['rtCriticsScore', 'rtVerifiedHot']);
    const first = buildRenderContext(
      movie(103),
      'movie',
      false,
      undefined,
      undefined,
      fields
    );
    const second = buildRenderContext(
      movie(103),
      'movie',
      false,
      undefined,
      undefined,
      fields
    );
    await vi.waitFor(() =>
      expect(mocks.getMovieRatings).toHaveBeenCalledTimes(1)
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    release(hotRating);
    const [a, b] = await Promise.all([first, second]);
    expect(mocks.getMovieRatings).toHaveBeenCalledTimes(1);
    expect(a.context.rtVerifiedHot).toBe(true);
    expect(b.context.rtVerifiedHot).toBe(true);
  });
});

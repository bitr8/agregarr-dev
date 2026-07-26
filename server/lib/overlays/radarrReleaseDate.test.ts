import { describe, expect, it } from 'vitest';

import { resolveRadarrFirstReleaseDate } from './OverlayContextBuilder';

// The fork#45 shape: TMDB has only a theatrical date, so the overlay drew
// theatrical+90 while the collection sort used Radarr's real digital date.
const tmdbEstimateOnly = {
  releaseDate: '2026-09-24',
  isEstimated: true,
  inCinemas: '2026-06-26T00:00:00.000Z',
};

describe('resolveRadarrFirstReleaseDate', () => {
  it("prefers Radarr's digital date over a TMDB theatrical+90 estimate", () => {
    const merged = resolveRadarrFirstReleaseDate(tmdbEstimateOnly, {
      digitalRelease: '2026-07-28T00:00:00.000Z',
    });

    expect(merged.releaseDate).toBe('2026-07-28');
    expect(merged.isEstimated).toBe(false);
  });

  it('keeps the TMDB date when Radarr knows no dates at all', () => {
    const merged = resolveRadarrFirstReleaseDate(tmdbEstimateOnly, {});

    expect(merged.releaseDate).toBe('2026-09-24');
    expect(merged.isEstimated).toBe(true);
  });

  it('merges per type: Radarr theatrical does not discard a TMDB digital date', () => {
    const merged = resolveRadarrFirstReleaseDate(
      {
        releaseDate: '2026-07-28',
        isEstimated: false,
        digitalRelease: '2026-07-28T00:00:00.000Z',
        inCinemas: '2026-06-26T00:00:00.000Z',
      },
      { inCinemas: '2026-06-20T00:00:00.000Z' }
    );

    expect(merged.releaseDate).toBe('2026-07-28');
    expect(merged.isEstimated).toBe(false);
  });

  it('lets Radarr theatrical replace an estimate that was already an estimate', () => {
    const merged = resolveRadarrFirstReleaseDate(
      { releaseDate: '2026-09-24', isEstimated: true },
      { inCinemas: '2026-06-01T00:00:00.000Z' }
    );

    expect(merged.releaseDate).toBe('2026-08-30');
    expect(merged.isEstimated).toBe(true);
  });

  it('never trades a published date for an estimate', () => {
    // The bare-fallback shape: TMDB gave a real release_date with no components
    // to merge against. A Radarr record holding only inCinemas must not turn it
    // into theatrical+90. This is the cached path's version of the same record.
    const merged = resolveRadarrFirstReleaseDate(
      { releaseDate: '2026-07-28' },
      { inCinemas: '2026-06-01T00:00:00.000Z' }
    );

    expect(merged.releaseDate).toBe('2026-07-28');
    expect(merged.isEstimated).toBeUndefined();
  });

  it('still upgrades a bare published date to a firmer Radarr digital date', () => {
    const merged = resolveRadarrFirstReleaseDate(
      { releaseDate: '2026-09-24' },
      { digitalRelease: '2026-07-28T00:00:00.000Z' }
    );

    expect(merged.releaseDate).toBe('2026-07-28');
    expect(merged.isEstimated).toBe(false);
  });

  it('never blanks a date TMDB supplied', () => {
    const merged = resolveRadarrFirstReleaseDate(
      { releaseDate: '2026-09-24' },
      {}
    );

    expect(merged.releaseDate).toBe('2026-09-24');
  });
});

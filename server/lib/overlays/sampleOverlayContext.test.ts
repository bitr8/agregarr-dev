import { describe, expect, it } from 'vitest';
// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths -- server tsconfig has no @app alias
import { AVAILABLE_VARIABLES } from '../../../src/components/OverlayEditor/types';

import { createSampleOverlayContext } from './sampleOverlayContext';

describe('sample overlay context', () => {
  it('does not provide variables the real render never sets', () => {
    for (const mediaType of ['movie', 'show'] as const) {
      expect(
        createSampleOverlayContext(mediaType).episodeLabel
      ).toBeUndefined();
    }
  });

  it('still provides the episode number', () => {
    expect(createSampleOverlayContext('show').episodeNumber).toBe(5);
  });
});

const EXCLUDED = new Set<string>([
  // A future-premiere show sample cannot also have a past season premiere.
  'daysAgoNextSeason',
  // The show sample has no Dolby Vision, so there is no profile to show.
  'showDolbyVisionProfile',
  // Collection rank is per collection and Arr tags per library; neither has a generic sample.
  'collectionRank',
  'radarrTags',
  'sonarrTags',
]);

const allVariables = Object.values(AVAILABLE_VARIABLES).flat() as {
  field: string;
  label: string;
}[];

const resolves = (context: Record<string, unknown>, field: string): boolean =>
  context[field] !== undefined && context[field] !== null;

describe('createSampleOverlayContext covers AVAILABLE_VARIABLES', () => {
  const movie = createSampleOverlayContext('movie') as unknown as Record<
    string,
    unknown
  >;
  const show = createSampleOverlayContext('show') as unknown as Record<
    string,
    unknown
  >;

  it('resolves every variable for at least one media type', () => {
    const missing = allVariables
      .map((v) => v.field)
      .filter((f) => !EXCLUDED.has(f))
      .filter((f) => !resolves(movie, f) && !resolves(show, f));
    expect(missing).toEqual([]);
  });

  it('resolves every TV variable on the show sample', () => {
    const missing = allVariables
      .filter((v) => v.label.includes('(TV)'))
      .map((v) => v.field)
      .filter((f) => !EXCLUDED.has(f) && !resolves(show, f));
    expect(missing).toEqual([]);
  });

  it('keeps the exclusions unresolved so the list stays honest', () => {
    for (const f of EXCLUDED) {
      expect(resolves(movie, f) || resolves(show, f)).toBe(false);
    }
  });

  it('derives day counts from the sample dates', () => {
    expect(movie.daysSinceAdded).toBeGreaterThan(0);
    expect(movie.daysSinceLastPlayed).toBeGreaterThan(0);
    expect(show.daysSinceAdded).toBe(movie.daysSinceAdded);
  });
});

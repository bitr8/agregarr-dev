/**
 * Why the movie producers set `isEstimated: false` explicitly rather than
 * leaving it absent.
 *
 * evaluateRule bails out on an undefined field for every operator except neq,
 * notContains and exists, so an "is a published date" condition written as
 * `isEstimatedReleaseDate == false` cannot match a field that was never set.
 * Leaving the bare-fallback path (TMDB `release_date` with no `release_dates`
 * block) undefined would silently drop those movies from that condition.
 */
import { describe, expect, it } from 'vitest';

import type { ApplicationCondition } from '@server/entity/OverlayTemplate';

import type { OverlayRenderContext } from './OverlayTemplateRenderer';
import { evaluateCondition } from './OverlayTemplateRenderer';
import { createSampleOverlayContext } from './sampleOverlayContext';

const flagIs = (value: boolean): ApplicationCondition => ({
  sections: [
    {
      sectionOperator: 'and',
      rules: [{ field: 'isEstimatedReleaseDate', operator: 'eq', value }],
    },
  ],
});

const flagIsNot = (value: boolean): ApplicationCondition => ({
  sections: [
    {
      sectionOperator: 'and',
      rules: [{ field: 'isEstimatedReleaseDate', operator: 'neq', value }],
    },
  ],
});

const isPublished = flagIs(false);
const isEstimate = flagIs(true);

const ctx = (over: Partial<OverlayRenderContext>): OverlayRenderContext =>
  ({ releaseDate: '2026-07-28', ...over } as OverlayRenderContext);

describe('isEstimatedReleaseDate as a condition field', () => {
  it('matches the estimate condition when the date is the +90 guess', () => {
    expect(
      evaluateCondition(isEstimate, ctx({ isEstimatedReleaseDate: true }))
    ).toBe(true);
  });

  it('matches the published condition when the date is real', () => {
    expect(
      evaluateCondition(isPublished, ctx({ isEstimatedReleaseDate: false }))
    ).toBe(true);
  });

  it('does not match the estimate condition on a published date', () => {
    expect(
      evaluateCondition(isEstimate, ctx({ isEstimatedReleaseDate: false }))
    ).toBe(false);
  });

  // The regression this file exists for: absent is NOT false to evaluateRule,
  // so a producer that omits the flag drops the item from the condition.
  it('does not match the published condition when the flag is absent', () => {
    expect(evaluateCondition(isPublished, ctx({}))).toBe(false);
  });
});

// Pairing a template on this field: the confirmed half must use `neq true`,
// not `eq false`. The flag is a third state, not a boolean - shows never get
// it - and `eq false` drops every one of them out of BOTH halves of the pair.
describe('splitting a template into estimated and confirmed halves', () => {
  const notEstimate = flagIsNot(true);

  it('neq true catches a published date', () => {
    expect(
      evaluateCondition(notEstimate, ctx({ isEstimatedReleaseDate: false }))
    ).toBe(true);
  });

  it('neq true also catches a show, where the flag is absent', () => {
    expect(evaluateCondition(notEstimate, ctx({}))).toBe(true);
  });

  it('eq false does NOT catch a show, which is why the pair must use neq', () => {
    expect(evaluateCondition(isPublished, ctx({}))).toBe(false);
  });

  it('the two halves stay mutually exclusive for a real estimate', () => {
    const estimated = ctx({ isEstimatedReleaseDate: true });
    expect(evaluateCondition(isEstimate, estimated)).toBe(true);
    expect(evaluateCondition(notEstimate, estimated)).toBe(false);
  });
});

// The preview has to agree with production or a condition matches while the
// user is building it and never matches once it runs. Only movies get a
// theatrical+90 estimate.
describe('sample context parity with production', () => {
  it('offers the flag for movies, since movies can be estimated', () => {
    expect(createSampleOverlayContext('movie').isEstimatedReleaseDate).toBe(
      false
    );
  });

  it('leaves it undefined for shows, as deriveReleaseDateContext does', () => {
    expect(
      createSampleOverlayContext('show').isEstimatedReleaseDate
    ).toBeUndefined();
  });
});

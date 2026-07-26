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

const flagIs = (value: boolean): ApplicationCondition => ({
  sections: [
    {
      sectionOperator: 'and',
      rules: [{ field: 'isEstimatedReleaseDate', operator: 'eq', value }],
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

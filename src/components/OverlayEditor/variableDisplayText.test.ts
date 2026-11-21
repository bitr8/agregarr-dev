import { describe, expect, it } from 'vitest';
import type {
  OverlayRenderContext,
  OverlayVariableElementProps,
} from './types';
import { buildVariableDisplayText } from './variableDisplayText';

const props = (
  segments: OverlayVariableElementProps['segments']
): OverlayVariableElementProps =>
  ({ segments } as unknown as OverlayVariableElementProps);

const rating = props([
  { type: 'text', value: 'IMDb ' },
  { type: 'variable', field: 'imdbRating' },
]);

describe('buildVariableDisplayText', () => {
  it('uses the preview poster value when the context has one', () => {
    const ctx = { imdbRating: 7.7 } as unknown as OverlayRenderContext;
    expect(buildVariableDisplayText(rating, ctx)).toBe('IMDb 7.7');
  });

  it('falls back to the sample value when the context lacks the field', () => {
    expect(
      buildVariableDisplayText(rating, {} as unknown as OverlayRenderContext)
    ).toBe('IMDb 8.7');
  });

  it('uses the sample value with no context', () => {
    expect(buildVariableDisplayText(rating)).toBe('IMDb 8.7');
  });

  it('formats a date field with the segment format', () => {
    const ctx = {
      releaseDate: '2026-11-17',
    } as unknown as OverlayRenderContext;
    expect(
      buildVariableDisplayText(
        props([
          { type: 'variable', field: 'releaseDate', format: 'DD/MM/YYYY' },
        ]),
        ctx
      )
    ).toBe('17/11/2026');
  });
});

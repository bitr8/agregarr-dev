import { describe, expect, it } from 'vitest';
import type {
  OverlayRenderContext,
  OverlayVariableElementProps,
} from './types';
import {
  buildVariableDisplayText,
  isNumberFormatVariable,
} from './variableDisplayText';

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

describe('number format in the preview', () => {
  const code = (format?: string) =>
    props([
      { type: 'text', value: 'S' },
      { type: 'variable', field: 'seasonNumber', format },
      { type: 'text', value: 'E' },
      { type: 'variable', field: 'episodeNumber', format },
    ]);

  it('pads context values', () => {
    const ctx = {
      seasonNumber: 1,
      episodeNumber: 5,
    } as unknown as OverlayRenderContext;
    expect(buildVariableDisplayText(code('pad2'), ctx)).toBe('S01E05');
    expect(buildVariableDisplayText(code('pad3'), ctx)).toBe('S001E005');
    expect(buildVariableDisplayText(code(), ctx)).toBe('S1E5');
  });

  it('pads the sample values when there is no context', () => {
    expect(buildVariableDisplayText(code('pad3'))).toBe('S005E016');
    expect(buildVariableDisplayText(code())).toBe('S5E16');
  });
});

describe('isNumberFormatVariable', () => {
  it('offers the dropdown on the allowlisted integer variables only', () => {
    for (const f of [
      'seasonNumber',
      'episodeNumber',
      'daysUntilNextEpisode',
      'viewCount',
    ]) {
      expect(isNumberFormatVariable(f), f).toBe(true);
    }
    for (const f of [
      'year',
      'daysSincePhysicalRelease',
      'daysUntilAction',
      'plexUserRating',
      'rtCriticsScore',
      'showResolution',
      'fileSize',
      'imdbRating',
      'releaseDate',
      'isPlaceholder',
      'title',
    ]) {
      expect(isNumberFormatVariable(f), f).toBe(false);
    }
  });

  it('previews an ineligible field with a stale pad format as the server renders it', () => {
    const stale = props([
      { type: 'variable', field: 'plexUserRating', format: 'pad2' },
      { type: 'text', value: '/' },
      { type: 'variable', field: 'rtCriticsScore', format: 'pad3' },
    ]);
    expect(buildVariableDisplayText(stale)).toBe('8/88');
    expect(
      buildVariableDisplayText(stale, {
        plexUserRating: 8,
        rtCriticsScore: 88,
      } as unknown as OverlayRenderContext)
    ).toBe('8/88');
  });
});

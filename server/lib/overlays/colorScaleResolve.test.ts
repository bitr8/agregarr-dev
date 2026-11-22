import { describe, expect, it } from 'vitest';

import type {
  ColorScale,
  OverlayTemplateData,
} from '@server/entity/OverlayTemplate';
import { extractUsedContextFields } from '@server/utils/metadataHashing';

import type { OverlayRenderContext } from './OverlayTemplateRenderer';
import { resolveColorScale } from './OverlayTemplateRenderer';

const scale = (field: string): ColorScale => ({
  field,
  min: 0,
  max: 100,
  fromColor: '#000000',
  toColor: '#ffffff',
});

const ctx = { rtCriticsScore: 100, rtAudienceScore: 0 } as OverlayRenderContext;

describe('color scale on Rotten Tomatoes scores', () => {
  it('colours from the critic score under the context field name', () => {
    expect(resolveColorScale(scale('rtCriticsScore'), ctx)).toBe('#ffffff');
    expect(resolveColorScale(scale('rtAudienceScore'), ctx)).toBe('#000000');
  });

  it('colours templates saved with the old field names', () => {
    expect(resolveColorScale(scale('rtCriticRating'), ctx)).toBe('#ffffff');
    expect(resolveColorScale(scale('rtAudienceRating'), ctx)).toBe('#000000');
  });

  it('hashes the score field for templates saved with the old names', () => {
    const data = {
      elements: [
        {
          type: 'tile',
          properties: {
            fillColor: '#111111',
            colorScale: scale('rtCriticRating'),
          },
        },
      ],
    } as unknown as OverlayTemplateData;
    expect(extractUsedContextFields([data]).has('rtCriticsScore')).toBe(true);
  });
});

describe('color scale with Max at or below Min', () => {
  const flat = (min: number, max: number): ColorScale => ({
    field: 'imdbRating',
    min,
    max,
    fromColor: '#000000',
    toColor: '#ffffff',
  });
  const rating = (imdbRating: number) =>
    ({ imdbRating } as OverlayRenderContext);

  it('steps from Low to High at Min instead of returning NaN', () => {
    expect(resolveColorScale(flat(5, 5), rating(5))).toBe('#ffffff');
    expect(resolveColorScale(flat(5, 5), rating(7))).toBe('#ffffff');
    expect(resolveColorScale(flat(5, 5), rating(4))).toBe('#000000');
  });

  it('treats Max below Min the same way', () => {
    expect(resolveColorScale(flat(6, 2), rating(6))).toBe('#ffffff');
    expect(resolveColorScale(flat(6, 2), rating(3))).toBe('#000000');
  });

  it('leaves a normal range untouched', () => {
    expect(resolveColorScale(flat(0, 10), rating(5))).toBe('#808080');
  });
});

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

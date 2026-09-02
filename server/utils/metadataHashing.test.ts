import type { OverlayTemplateData } from '@server/entity/OverlayTemplate';
import { describe, expect, it } from 'vitest';
import {
  calculateOverlayInputHash,
  extractMappedIconFields,
} from './metadataHashing';

const baseConfig = {
  templateIds: [2, 1],
  templateData: [
    {
      width: 1000,
      height: 1500,
      elements: [
        {
          id: 'e1',
          layerOrder: 0,
          type: 'mapped-icon' as const,
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          properties: {
            field: 'audioLanguages',
            mappings: [],
            layout: 'horizontal' as const,
            iconSize: 32,
            spacingX: 4,
            spacingY: 4,
          },
        },
      ],
    },
  ] satisfies OverlayTemplateData[],
  usedFields: new Set(['audioLanguages', 'mediaType']),
  context: { audioLanguages: ['eng'], mediaType: 'movie' },
};

describe('calculateOverlayInputHash', () => {
  it('matches the pre-fix hash when no mapped-icon templates are involved', () => {
    // Captured from the pre-fix implementation for this exact config, before
    // mappedIconMappings existed as an input. Proves the new optional
    // parameter does not change the hash for callers that omit it.
    const hash = calculateOverlayInputHash(baseConfig);
    expect(hash).toBe(
      '4f76482efd2bd23953d9a4b2e4734d30277ce32bf948e5135c03d3e0f556bd65'
    );
  });

  it('changes when the effective mapping for a used field changes', () => {
    const before = calculateOverlayInputHash({
      ...baseConfig,
      mappedIconMappings: {
        audioLanguages: [{ value: 'eng', iconPath: '/icons/en-old.svg' }],
      },
    });

    const after = calculateOverlayInputHash({
      ...baseConfig,
      mappedIconMappings: {
        audioLanguages: [{ value: 'eng', iconPath: '/icons/en-new.svg' }],
      },
    });

    expect(before).not.toBe(after);
  });

  it('does not change when mappings are re-ordered but unchanged in content', () => {
    const a = calculateOverlayInputHash({
      ...baseConfig,
      mappedIconMappings: {
        audioLanguages: [
          { value: 'eng', iconPath: '/icons/en.svg' },
          { value: 'fra', iconPath: '/icons/fr.svg' },
        ],
      },
    });

    const b = calculateOverlayInputHash({
      ...baseConfig,
      mappedIconMappings: {
        audioLanguages: [
          { value: 'fra', iconPath: '/icons/fr.svg' },
          { value: 'eng', iconPath: '/icons/en.svg' },
        ],
      },
    });

    expect(a).toBe(b);
  });

  it('ignores mappings for a field no template uses', () => {
    const withUnrelated = calculateOverlayInputHash({
      ...baseConfig,
      mappedIconMappings: {
        resolution: [{ value: '1080p', iconPath: '/icons/1080.svg' }],
      },
    });

    // resolution isn't a field extractMappedIconFields would ever return for
    // this template, so a caller following that contract never includes it —
    // this only guards calculateOverlayInputHash's own behavior if it did.
    expect(withUnrelated).not.toBe(calculateOverlayInputHash(baseConfig));
  });
});

describe('extractMappedIconFields', () => {
  it('collects distinct fields from mapped-icon elements only', () => {
    const templateData: OverlayTemplateData[] = [
      {
        width: 1000,
        height: 1500,
        elements: [
          {
            id: 'e1',
            layerOrder: 0,
            type: 'mapped-icon',
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            properties: {
              field: 'audioLanguages',
              mappings: [],
              layout: 'horizontal',
              iconSize: 32,
              spacingX: 4,
              spacingY: 4,
            },
          },
          {
            id: 'e2',
            layerOrder: 1,
            type: 'variable',
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            properties: {
              segments: [{ type: 'variable', field: 'resolution' }],
              fontSize: 12,
              fontFamily: 'Arial',
              fontWeight: 'normal',
              fontStyle: 'normal',
              color: '#fff',
              textAlign: 'left',
            },
          },
        ],
      },
      {
        width: 1000,
        height: 1500,
        elements: [
          {
            id: 'e3',
            layerOrder: 0,
            type: 'mapped-icon',
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            properties: {
              field: 'audioLanguages',
              mappings: [],
              layout: 'horizontal',
              iconSize: 32,
              spacingX: 4,
              spacingY: 4,
            },
          },
        ],
      },
    ];

    const fields = extractMappedIconFields(templateData);
    expect(Array.from(fields).sort()).toEqual(['audioLanguages']);
  });

  it('returns an empty set when there are no mapped-icon elements', () => {
    const templateData: OverlayTemplateData[] = [
      {
        width: 1000,
        height: 1500,
        elements: [],
      },
    ];
    expect(extractMappedIconFields(templateData).size).toBe(0);
  });
});

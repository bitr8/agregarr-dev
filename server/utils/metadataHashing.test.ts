import type { OverlayTemplateData } from '@server/entity/OverlayTemplate';
import { describe, expect, it } from 'vitest';
import {
  calculateOverlayInputHash,
  calculatePosterInputHash,
  extractMappedIconFields,
  posterTemplateReadsCollectionType,
  posterTemplateReadsField,
  templatesReadContextField,
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

// Digest of baseConfig on the last build before Posterizarr (fe0355ed). Re-baking
// this constant means every user re-renders every poster; do it on purpose.
const PRE_POSTERIZARR_OVERLAY_HASH =
  '4f76482efd2bd23953d9a4b2e4734d30277ce32bf948e5135c03d3e0f556bd65';

describe('calculateOverlayInputHash', () => {
  it('keeps the pre-Posterizarr digest when no render options are supplied', () => {
    expect(calculateOverlayInputHash(baseConfig)).toBe(
      PRE_POSTERIZARR_OVERLAY_HASH
    );
    expect(
      calculateOverlayInputHash({ ...baseConfig, renderOptions: undefined })
    ).toBe(PRE_POSTERIZARR_OVERLAY_HASH);
  });

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

  it('hashes any mappedIconMappings it is given, even for an unused field', () => {
    const withUnrelated = calculateOverlayInputHash({
      ...baseConfig,
      mappedIconMappings: {
        resolution: [{ value: '1080p', iconPath: '/icons/1080.svg' }],
      },
    });

    // calculateOverlayInputHash does not filter by used fields — that's
    // extractMappedIconFields's job at the call site. resolution isn't a
    // field extractMappedIconFields would ever return for this template, so
    // a caller following that contract never passes it; this only pins the
    // function's own behavior if it did.
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

describe('overlay input hashing', () => {
  it('regenerates artwork when output quality changes', () => {
    const base = {
      templateIds: [],
      templateData: [],
      usedFields: new Set<string>(),
      context: {},
    };

    const quality95 = calculateOverlayInputHash({
      ...base,
      renderOptions: { format: 'jpeg', jpegQuality: 95 },
    });
    const quality100 = calculateOverlayInputHash({
      ...base,
      renderOptions: { format: 'jpeg', jpegQuality: 100 },
    });

    expect(quality95).not.toBe(quality100);
  });

  it('regenerates artwork when an effective mapped icon changes', () => {
    const templateData = [
      {
        width: 1000,
        height: 1500,
        elements: [
          {
            id: 'audio',
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
    ] satisfies OverlayTemplateData[];
    const base = {
      templateIds: [1],
      templateData,
      usedFields: new Set(['audioLanguages']),
      context: { audioLanguages: ['eng'] },
      renderOptions: { format: 'jpeg', jpegQuality: 95 },
    };

    const before = calculateOverlayInputHash({
      ...base,
      mappedIconMappings: {
        audioLanguages: [{ value: 'eng', iconPath: '/icons/old.svg' }],
      },
    });
    const after = calculateOverlayInputHash({
      ...base,
      mappedIconMappings: {
        audioLanguages: [{ value: 'eng', iconPath: '/icons/new.svg' }],
      },
    });

    expect(before).not.toBe(after);
    expect(extractMappedIconFields(templateData)).toEqual(
      new Set(['audioLanguages'])
    );
  });

  it('normalizes mapped-icon ordering without dropping render options', () => {
    const base = {
      templateIds: [],
      templateData: [],
      usedFields: new Set<string>(),
      context: {},
      renderOptions: { format: 'jpeg', jpegQuality: 95 },
    };
    const first = calculateOverlayInputHash({
      ...base,
      mappedIconMappings: {
        audioLanguages: [
          { value: 'eng', iconPath: '/icons/en.svg' },
          { value: 'fra', iconPath: '/icons/fr.svg' },
        ],
      },
    });
    const reordered = calculateOverlayInputHash({
      ...base,
      mappedIconMappings: {
        audioLanguages: [
          { value: 'fra', iconPath: '/icons/fr.svg' },
          { value: 'eng', iconPath: '/icons/en.svg' },
        ],
      },
    });
    const differentQuality = calculateOverlayInputHash({
      ...base,
      renderOptions: { format: 'jpeg', jpegQuality: 90 },
      mappedIconMappings: {
        audioLanguages: [
          { value: 'eng', iconPath: '/icons/en.svg' },
          { value: 'fra', iconPath: '/icons/fr.svg' },
        ],
      },
    });

    expect(first).toBe(reordered);
    expect(first).not.toBe(differentQuality);
  });
});

describe('render effects in the overlay input hash', () => {
  const tpl = (
    iconProps: object = {},
    tileProps: object = {}
  ): OverlayTemplateData => ({
    width: 1000,
    height: 1500,
    elements: [
      {
        id: 's',
        layerOrder: 0,
        type: 'svg',
        x: 0,
        y: 0,
        width: 40,
        height: 20,
        properties: {
          iconType: 'custom-icon',
          iconPath: '/a.svg',
          opacity: 100,
          grayscale: false,
          ...iconProps,
        },
      },
      {
        id: 't',
        layerOrder: 1,
        type: 'tile',
        x: 0,
        y: 0,
        width: 40,
        height: 20,
        properties: {
          fillColor: '#000',
          fillOpacity: 100,
          borderWidth: 0,
          ...tileProps,
        },
      },
    ],
  });
  const hashOf = (t: OverlayTemplateData) =>
    calculateOverlayInputHash({
      templateIds: [1],
      templateData: [t],
      usedFields: new Set(['title']),
      context: { title: 'x' },
    });

  it('keeps the hash of a template using only defaults', () => {
    expect(hashOf(tpl())).toBe(
      '8c9236d4093793958c27b7edfdc9d4656360292f2c9994fb7aeb03c806f18b31'
    );
  });

  it('moves the hash off its previous value for templates using effects', () => {
    const developHashes = [
      '112b491a18ef253d352934b316407284f78de5680ff7693effeaa61259137381',
      'f4400079cf425a3cfcfb9653672a082acf2557db09a668a25628cc62184184fc',
      'f87eac10a9ecd1a292d9611521a7175c1b712be946e173d02164299b01e3e31f',
      'c2d7d5859e01e26bac084827c0a023c6e1706e35ca31783190b10c55443026b5',
    ];
    const flat = {
      colorScale: {
        field: 'imdbRating',
        min: 5,
        max: 5,
        fromColor: '#000000',
        toColor: '#ffffff',
      },
    };
    const now = [
      hashOf(tpl({ opacity: 50 })),
      hashOf(tpl({ grayscale: true })),
      hashOf(tpl({}, { borderWidth: 4 })),
      hashOf(tpl({}, flat)),
    ];
    now.forEach((hash, i) => expect(hash).not.toBe(developHashes[i]));
  });
});

describe('poster item count hashing', () => {
  const rule = (field: string) => ({
    sections: [{ rules: [{ field, operator: 'gte', value: 10 }] }],
  });
  const tpl = (field: string) =>
    JSON.stringify({ elements: [{ id: 'a', condition: rule(field) }] });
  const base = { templateId: 1, itemIds: ['a'], collectionName: 'C' };

  it('detects itemCount rules in templateData JSON', () => {
    expect(posterTemplateReadsField(tpl('itemCount'), 'itemCount')).toBe(true);
    expect(posterTemplateReadsField(tpl('mediaType'), 'itemCount')).toBe(false);
    expect(posterTemplateReadsField('not json', 'itemCount')).toBe(false);
    expect(posterTemplateReadsField(null, 'itemCount')).toBe(false);
  });

  it('leaves the hash unchanged when no count is supplied', () => {
    expect(calculatePosterInputHash({ ...base, itemCount: undefined })).toBe(
      calculatePosterInputHash(base)
    );
  });

  it('changes the hash when the supplied count changes', () => {
    expect(calculatePosterInputHash({ ...base, itemCount: 9 })).not.toBe(
      calculatePosterInputHash({ ...base, itemCount: 10 })
    );
  });
});

describe('templatesReadContextField', () => {
  const mk = (
    elementCondition?: unknown,
    appCondition?: unknown
  ): Parameters<typeof templatesReadContextField>[0][number] => ({
    getTemplateData: () =>
      ({
        width: 1,
        height: 1,
        elements: [
          {
            id: 'e',
            layerOrder: 0,
            type: 'tile',
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            properties: {},
            condition: elementCondition,
          },
        ],
      } as unknown as OverlayTemplateData),
    getApplicationCondition: () => appCondition as never,
  });
  const rule = (field: string) => ({
    sections: [{ rules: [{ field, operator: 'eq', value: 'x' }] }],
  });

  it('sees a collection rule on an element condition', () => {
    expect(
      templatesReadContextField([mk(rule('collection'))], 'collection')
    ).toBe(true);
  });

  it('sees a collection rule on an application condition', () => {
    expect(
      templatesReadContextField(
        [mk(undefined, rule('collection'))],
        'collection'
      )
    ).toBe(true);
  });

  it('is false when no condition reads it', () => {
    expect(
      templatesReadContextField([mk(rule('imdbRating'))], 'collection')
    ).toBe(false);
    expect(templatesReadContextField([], 'collection')).toBe(false);
  });
});

describe('poster condition collection type hashing', () => {
  const tpl = (field: string) =>
    JSON.stringify({
      elements: [
        {
          id: 'a',
          condition: {
            sections: [{ rules: [{ field, operator: 'eq', value: 'x' }] }],
          },
        },
      ],
    });
  const base = {
    templateId: 1,
    itemIds: ['a'],
    collectionName: 'C',
    collectionType: 'netflix',
    collectionSubtype: 'netflix_top_10',
  };

  it('detects collection type and subtype rules only', () => {
    expect(posterTemplateReadsCollectionType(tpl('collectionType'))).toBe(true);
    expect(posterTemplateReadsCollectionType(tpl('collectionSubtype'))).toBe(
      true
    );
    expect(posterTemplateReadsCollectionType(tpl('mediaType'))).toBe(false);
    expect(posterTemplateReadsCollectionType(null)).toBe(false);
  });

  it('keeps the hash identical when no condition type is supplied', () => {
    expect(
      calculatePosterInputHash({
        ...base,
        conditionCollectionType: undefined,
        conditionCollectionSubtype: undefined,
      })
    ).toBe(calculatePosterInputHash(base));
  });

  it('changes the hash when the condition type changes', () => {
    expect(
      calculatePosterInputHash({ ...base, conditionCollectionType: 'networks' })
    ).not.toBe(calculatePosterInputHash(base));
    expect(
      calculatePosterInputHash({ ...base, conditionCollectionType: 'networks' })
    ).not.toBe(
      calculatePosterInputHash({
        ...base,
        conditionCollectionType: 'originals',
      })
    );
  });
});

describe('date rendering in the overlay input hash', () => {
  const withFields = (fields: string[]) =>
    calculateOverlayInputHash({
      ...baseConfig,
      usedFields: new Set(fields),
      context: { releaseDate: '2026-12-03', imdbRating: 8 },
    });

  it('changes with the server timezone when a date field is used', () => {
    const prev = process.env.TZ;
    process.env.TZ = 'Australia/Sydney';
    const sydney = withFields(['releaseDate']);
    process.env.TZ = 'Pacific/Auckland';
    const auckland = withFields(['releaseDate']);
    process.env.TZ = prev;
    expect(sydney).not.toBe(auckland);
  });

  it('ignores the timezone when no date field is used', () => {
    const prev = process.env.TZ;
    process.env.TZ = 'Australia/Sydney';
    const sydney = withFields(['imdbRating']);
    process.env.TZ = 'Pacific/Auckland';
    const auckland = withFields(['imdbRating']);
    process.env.TZ = prev;
    expect(sydney).toBe(auckland);
  });
});

describe('characterisation: segment format is inside the hashed templateData', () => {
  const variable = (format?: string) =>
    ({
      width: 1920,
      height: 1080,
      elements: [
        {
          id: 'v1',
          layerOrder: 0,
          type: 'variable' as const,
          x: 0,
          y: 0,
          width: 305,
          height: 105,
          properties: {
            segments: [{ type: 'variable', field: 'episodeNumber', format }],
            fontSize: 55,
            fontFamily: 'Inter',
            fontWeight: 'normal',
            fontStyle: 'normal',
            color: '#fff',
            textAlign: 'center',
          },
        },
      ],
    } as unknown as OverlayTemplateData);
  const hash = (format?: string) =>
    calculateOverlayInputHash({
      templateIds: [1],
      templateData: [variable(format)],
      usedFields: new Set(['episodeNumber']),
      context: { episodeNumber: 5 },
    });

  it('changes the hash when a segment format changes', () => {
    expect(hash('pad2')).not.toBe(hash(undefined));
    expect(hash('pad2')).not.toBe(hash('pad3'));
  });
});

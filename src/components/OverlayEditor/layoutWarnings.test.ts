import { describe, expect, it } from 'vitest';
import {
  computeLayoutWarnings,
  conditionsMutuallyExclusive,
} from './layoutWarnings';
import type {
  ApplicationCondition,
  OverlayElement,
  OverlayTextElementProps,
} from './types';

const textEl = (
  id: string,
  rect: [number, number, number, number],
  text: string,
  extra: Partial<OverlayElement> = {},
  props: Partial<OverlayTextElementProps> = {}
): OverlayElement => ({
  id,
  layerOrder: 1,
  type: 'text',
  x: rect[0],
  y: rect[1],
  width: rect[2],
  height: rect[3],
  properties: {
    text,
    fontSize: 20,
    fontFamily: 'Arial',
    fontWeight: 'normal',
    fontStyle: 'normal',
    color: '#fff',
    textAlign: 'center',
    ...props,
  },
  ...extra,
});

const tileEl = (
  id: string,
  rect: [number, number, number, number]
): OverlayElement => ({
  id,
  layerOrder: 0,
  type: 'tile',
  x: rect[0],
  y: rect[1],
  width: rect[2],
  height: rect[3],
  properties: { fillColor: '#000', fillOpacity: 1 },
});

const cond = (
  field: string,
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'in',
  value: string | number | (string | number)[]
): ApplicationCondition => ({
  sections: [{ rules: [{ field, operator, value }] }],
});

const base = { width: 1000, height: 1500 };

describe('computeLayoutWarnings', () => {
  it('returns nothing for a clean layout', () => {
    const w = computeLayoutWarnings({
      ...base,
      elements: [
        tileEl('t', [100, 100, 400, 80]),
        textEl('a', [100, 100, 400, 80], 'READY'),
      ],
    });
    expect(w).toEqual([]);
  });

  it('flags elements outside the poster, including rotated bounds', () => {
    const w = computeLayoutWarnings({
      ...base,
      elements: [
        tileEl('left', [-20, 100, 100, 50]),
        { ...tileEl('rot', [800, 700, 200, 20]), rotation: 90 },
        tileEl('ok', [0, 0, 1000, 1500]),
      ],
    });
    expect(w.map((x) => [x.kind, x.elementId])).toEqual([
      ['out-of-bounds', 'left'],
    ]);
  });

  it('flags a word wider than its box as clipped', () => {
    const w = computeLayoutWarnings({
      ...base,
      elements: [textEl('a', [100, 100, 80, 40], 'PARTLYXXXXXX4K')],
    });
    expect(w.some((x) => x.kind === 'text-clipped')).toBe(true);
  });

  it('flags text taller than its box as clipped', () => {
    const w = computeLayoutWarnings({
      ...base,
      elements: [textEl('a', [100, 100, 400, 30], 'OK', {}, { fontSize: 48 })],
    });
    expect(w.some((x) => x.kind === 'text-clipped')).toBe(true);
  });

  it('flags multiword text that would only fit after wrapping', () => {
    const w = computeLayoutWarnings({
      ...base,
      elements: [textEl('a', [100, 100, 200, 60], 'one two three four five')],
    });
    expect(w.some((x) => x.kind === 'text-clipped')).toBe(true);
  });

  it('flags text that spills out of the badge behind it', () => {
    const w = computeLayoutWarnings({
      ...base,
      elements: [
        tileEl('badge', [100, 100, 150, 60]),
        textEl('a', [50, 100, 300, 60], 'AWAITING DOWNLOAD'),
      ],
    });
    expect(w.some((x) => x.kind === 'text-outside-badge')).toBe(true);
  });

  it('flags overlapping text and ignores overlapping backgrounds', () => {
    const w = computeLayoutWarnings({
      ...base,
      elements: [
        tileEl('t1', [100, 100, 400, 80]),
        tileEl('t2', [100, 120, 400, 80]),
        textEl('a', [100, 100, 400, 80], 'READY TO BE REQUESTED'),
        textEl('b', [100, 110, 400, 60], 'AWAITING DOWNLOAD'),
      ],
    });
    const overlaps = w.filter((x) => x.kind === 'text-overlap');
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].elementId).toBe('a');
    expect(overlaps[0].otherElementId).toBe('b');
  });

  it('does not flag overlap between mutually exclusive element conditions', () => {
    const w = computeLayoutWarnings({
      ...base,
      elements: [
        textEl('a', [100, 100, 400, 80], 'REQUESTABLE', {
          condition: cond('resolution', 'eq', '4K'),
        }),
        textEl('b', [100, 100, 400, 80], 'DOWNLOADING', {
          condition: cond('resolution', 'eq', '1080p'),
        }),
      ],
    });
    expect(w).toEqual([]);
  });

  it('checks other overlays and honours their template conditions', () => {
    const other = {
      label: 'Other',
      elements: [textEl('o', [100, 100, 400, 80], 'OTHER')],
    };
    const own = [textEl('a', [100, 100, 400, 80], 'MINE')];
    const clash = computeLayoutWarnings({
      ...base,
      elements: own,
      others: [other],
    });
    expect(clash.map((x) => x.otherLabel)).toEqual(['Other']);

    const apart = computeLayoutWarnings({
      ...base,
      elements: own,
      condition: cond('resolution', 'eq', '4K'),
      others: [{ ...other, condition: cond('resolution', 'eq', '1080') }],
    });
    expect(apart).toEqual([]);
  });

  it('flags a variable element wider than its box', () => {
    const w = computeLayoutWarnings({
      ...base,
      elements: [
        {
          id: 'v',
          layerOrder: 1,
          type: 'variable',
          x: 100,
          y: 100,
          width: 60,
          height: 40,
          properties: {
            segments: [
              { type: 'text', value: 'SEASONNUMBER' },
              { type: 'variable', field: 'seasonNumber' },
            ],
            fontSize: 20,
            fontFamily: 'Arial',
            fontWeight: 'normal',
            fontStyle: 'normal',
            color: '#fff',
            textAlign: 'center',
          },
        },
      ],
    });
    expect(w.some((x) => x.kind === 'text-clipped')).toBe(true);
  });
});

describe('conditionsMutuallyExclusive', () => {
  it('detects disjoint values, lists, ranges and eq/neq', () => {
    expect(
      conditionsMutuallyExclusive(
        cond('resolution', 'eq', 'a'),
        cond('resolution', 'eq', 'b')
      )
    ).toBe(true);
    expect(
      conditionsMutuallyExclusive(
        cond('resolution', 'in', ['a', 'b']),
        cond('resolution', 'eq', 'c')
      )
    ).toBe(true);
    expect(
      conditionsMutuallyExclusive(
        cond('imdbRating', 'gt', 8),
        cond('imdbRating', 'lt', 5)
      )
    ).toBe(true);
    expect(
      conditionsMutuallyExclusive(
        cond('resolution', 'eq', 'a'),
        cond('resolution', 'neq', 'a')
      )
    ).toBe(true);
  });

  it('stays conservative when it cannot prove exclusivity', () => {
    expect(
      conditionsMutuallyExclusive(
        cond('imdbRating', 'gt', 5),
        cond('imdbRating', 'lt', 8)
      )
    ).toBe(false);
    expect(
      conditionsMutuallyExclusive(
        cond('resolution', 'eq', 'a'),
        cond('container', 'eq', 'b')
      )
    ).toBe(false);
    expect(
      conditionsMutuallyExclusive(undefined, cond('resolution', 'eq', 'a'))
    ).toBe(false);
    const withOr: ApplicationCondition = {
      sections: [
        { rules: [{ field: 'resolution', operator: 'eq', value: 'a' }] },
        {
          sectionOperator: 'or',
          rules: [{ field: 'resolution', operator: 'eq', value: 'c' }],
        },
      ],
    };
    expect(
      conditionsMutuallyExclusive(withOr, cond('resolution', 'eq', 'c'))
    ).toBe(false);
  });

  it('treats an omitted sectionOperator as OR', () => {
    const omitted: ApplicationCondition = {
      sections: [
        { rules: [{ field: 'resolution', operator: 'eq', value: 'a' }] },
        { rules: [{ field: 'resolution', operator: 'eq', value: 'c' }] },
      ],
    };
    expect(
      conditionsMutuallyExclusive(omitted, cond('resolution', 'eq', 'c'))
    ).toBe(false);
    const explicitAnd: ApplicationCondition = {
      sections: [
        { rules: [{ field: 'resolution', operator: 'eq', value: 'a' }] },
        {
          sectionOperator: 'and',
          rules: [{ field: 'imdbRating', operator: 'gt', value: 1 }],
        },
      ],
    };
    expect(
      conditionsMutuallyExclusive(explicitAnd, cond('resolution', 'eq', 'c'))
    ).toBe(true);
  });

  it('does not treat array fields as disjoint', () => {
    expect(
      conditionsMutuallyExclusive(
        cond('radarrTags', 'eq', 'a'),
        cond('radarrTags', 'eq', 'b')
      )
    ).toBe(false);
    expect(
      conditionsMutuallyExclusive(
        cond('radarrTags', 'eq', 'a'),
        cond('radarrTags', 'neq', 'a')
      )
    ).toBe(true);
  });
});

describe('computeLayoutWarnings rotation and badges', () => {
  it('uses the rotated extent for overlap', () => {
    const rotated = textEl('a', [100, 300, 400, 40], 'ROTATED TEXT', {
      rotation: 90,
    });
    const below = textEl('b', [250, 360, 100, 40], 'BELOW');
    const apart = computeLayoutWarnings({
      ...base,
      elements: [{ ...rotated, rotation: 0 }, below],
    });
    expect(apart).toEqual([]);
    const hit = computeLayoutWarnings({ ...base, elements: [rotated, below] });
    expect(hit.some((x) => x.kind === 'text-overlap')).toBe(true);
  });

  it('measures against the nearest badge beneath the text', () => {
    const background = tileEl('bg', [0, 0, 1000, 400]);
    const badge = { ...tileEl('badge', [100, 100, 150, 60]), layerOrder: 1 };
    const label = {
      ...textEl('label', [50, 100, 300, 60], 'AWAITING DOWNLOAD'),
      layerOrder: 2,
    };
    const w = computeLayoutWarnings({
      ...base,
      elements: [background, badge, label],
    });
    expect(w.some((x) => x.kind === 'text-outside-badge')).toBe(true);
  });
});

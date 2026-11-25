import { describe, expect, it } from 'vitest';
import { colorScaleFieldOptions, parseScaleBound } from './colorScaleInputs';

describe('colorScaleFieldOptions', () => {
  it('offers the four fields for a known field', () => {
    expect(colorScaleFieldOptions('imdbRating').map((f) => f.field)).toEqual([
      'imdbRating',
      'tmdbRating',
      'rtCriticsScore',
      'rtAudienceScore',
    ]);
  });

  it('maps legacy names to their current option', () => {
    expect(colorScaleFieldOptions('rtCriticRating')).toHaveLength(4);
  });

  it('adds an unknown stored field as an extra option', () => {
    const options = colorScaleFieldOptions('daysUntilRelease');
    expect(options).toHaveLength(5);
    expect(options[4]).toEqual({
      field: 'daysUntilRelease',
      label: 'daysUntilRelease',
    });
  });
});

describe('parseScaleBound', () => {
  it('keeps the previous value when the box is cleared', () => {
    expect(parseScaleBound('', 7)).toBe(7);
    expect(parseScaleBound('  ', 7)).toBe(7);
  });

  it('parses numbers, including zero and negatives', () => {
    expect(parseScaleBound('0', 7)).toBe(0);
    expect(parseScaleBound('-2.5', 7)).toBe(-2.5);
  });

  it('settles the half-typed drafts a user passes through', () => {
    expect(parseScaleBound('2.', 7)).toBe(2);
    expect(parseScaleBound('-', 7)).toBe(7);
    expect(parseScaleBound('-1', 7)).toBe(-1);
  });

  it('keeps the previous value for non-numbers', () => {
    expect(parseScaleBound('abc', 7)).toBe(7);
  });
});

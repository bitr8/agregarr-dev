import { describe, expect, it } from 'vitest';
import { DEFAULT_MIN_WIDTH, fitColumnWidth } from './useColumnWidths';

// One pixel per character keeps the arithmetic readable.
const measure = (text: string) => text.length;

describe('fitColumnWidth', () => {
  it('fits the longest cell plus padding', () => {
    expect(
      fitColumnWidth(
        { key: 'name', header: 'Name', cells: ['x'.repeat(100)] },
        measure
      )
    ).toBe(124);
  });

  it('wraps the header a word per line instead of widening for it', () => {
    expect(
      fitColumnWidth(
        { key: 'h', header: 'Minimum RT Audience Rating', min: 0 },
        measure
      )
    ).toBe('Audience'.length + 24 + 16);
  });

  it('keeps to the min and max', () => {
    expect(fitColumnWidth({ key: 'a', header: 'A' }, measure)).toBe(
      DEFAULT_MIN_WIDTH
    );
    expect(
      fitColumnWidth({ key: 'n', header: 'N', cells: ['x'], min: 192 }, measure)
    ).toBe(192);
    expect(
      fitColumnWidth(
        { key: 'n', header: 'N', cells: ['x'.repeat(900)], max: 360 },
        measure
      )
    ).toBe(360);
  });
});

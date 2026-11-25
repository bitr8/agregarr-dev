import { describe, expect, it } from 'vitest';
import { isResizable } from './elementTransform';

describe('isResizable', () => {
  it('is false for mapped icons, whose size comes from Icon Size and layout', () => {
    expect(isResizable('mapped-icon')).toBe(false);
  });

  it('is true for every other element type', () => {
    for (const type of ['text', 'tile', 'variable', 'raster', 'svg'] as const) {
      expect(isResizable(type)).toBe(true);
    }
  });
});

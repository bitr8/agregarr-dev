import { describe, expect, it } from 'vitest';
import { mappedIconContentSize } from './mappedIconLayout';

describe('mappedIconContentSize', () => {
  it('sizes a horizontal row', () => {
    expect(mappedIconContentSize(3, 20, 4, 9, 'horizontal', 3)).toEqual({
      width: 68,
      height: 20,
    });
  });

  it('sizes a vertical stack', () => {
    expect(mappedIconContentSize(3, 20, 4, 9, 'vertical', 3)).toEqual({
      width: 20,
      height: 78,
    });
  });

  it('sizes a grid', () => {
    expect(mappedIconContentSize(5, 20, 4, 9, 'grid', 2)).toEqual({
      width: 44,
      height: 78,
    });
  });

  it('allows negative spacing and falls back to one cell with no icons', () => {
    expect(mappedIconContentSize(2, 20, -5, 0, 'horizontal', 3).width).toBe(35);
    expect(mappedIconContentSize(0, 20, 4, 4, 'grid', 3)).toEqual({
      width: 20,
      height: 20,
    });
  });
});

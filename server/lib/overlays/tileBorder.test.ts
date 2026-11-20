import { describe, expect, it } from 'vitest';
import { insetTileBorder } from './tileBorder';

const radii = { topLeft: 10, topRight: 10, bottomRight: 1, bottomLeft: 0 };

describe('insetTileBorder', () => {
  it('keeps the whole stroke inside the box', () => {
    const b = insetTileBorder(100, 40, radii, 4);
    expect(b.inset).toBe(2);
    expect(b.inset - 4 / 2).toBe(0);
    expect(b.inset + b.width + 4 / 2).toBe(100);
    expect(b.inset + b.height + 4 / 2).toBe(40);
  });

  it('reduces corner radii by the inset and floors at zero', () => {
    expect(insetTileBorder(100, 40, radii, 4).radii).toEqual({
      topLeft: 8,
      topRight: 8,
      bottomRight: 0,
      bottomLeft: 0,
    });
  });

  it('clamps a border wider than the tile to half the short side', () => {
    const b = insetTileBorder(10, 40, radii, 30);
    expect(b.strokeWidth).toBe(5);
    expect(b.inset).toBe(2.5);
    expect(b.width).toBe(5);
    expect(b.height).toBe(35);
  });
});

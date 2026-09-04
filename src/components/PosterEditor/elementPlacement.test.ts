import { stackedY } from '@app/components/PosterEditor/elementPlacement';
import { describe, expect, it } from 'vitest';

describe('stackedY', () => {
  it('returns base when count is 0', () => {
    expect(stackedY(200, 50, 0, 1500, 50)).toBe(200);
  });

  it('clamps placement so the element stays inside the canvas', () => {
    expect(stackedY(100, 70, 20, 1500, 50)).toBe(1450);
  });

  it('returns 0 when the element is taller than the canvas', () => {
    expect(stackedY(150, 80, 17, 50, 100)).toBe(0);
  });
});

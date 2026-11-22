import { describe, expect, it } from 'vitest';
import { containScale } from './imageFit';

describe('containScale', () => {
  it('shrinks a wide icon to the box width', () => {
    expect(containScale(50, 100, 200, 100)).toBe(0.25);
  });

  it('fits to height when the box is wider than the icon', () => {
    expect(containScale(400, 50, 200, 100)).toBe(0.5);
  });
});

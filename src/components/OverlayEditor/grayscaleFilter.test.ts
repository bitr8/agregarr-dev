import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { grayLevel, sharpGrayscaleFilter } from './grayscaleFilter';

const vectors: [number, number, number][] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [128, 128, 128],
  [224, 172, 105],
];

describe('grayscale filter', () => {
  it('matches the poster grayscale within 2 levels', async () => {
    for (const [r, g, b] of vectors) {
      const out = await sharp({
        create: { width: 1, height: 1, channels: 3, background: { r, g, b } },
      })
        .grayscale()
        .raw()
        .toBuffer();
      expect(Math.abs(grayLevel(r, g, b) - out[0])).toBeLessThanOrEqual(2);
    }
  });

  it('rewrites pixels in place and keeps alpha', () => {
    const data = new Uint8ClampedArray([255, 0, 0, 77]);
    sharpGrayscaleFilter({ data });
    expect(Array.from(data)).toEqual([127, 127, 127, 77]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OVERLAY_JPEG_QUALITY,
  isValidOverlayJpegQuality,
  normalizeOverlayJpegQuality,
} from './overlayOutputQuality';

describe('overlay output quality', () => {
  it.each([1, 60, 95, 100])('accepts integer quality %i', (quality) => {
    expect(isValidOverlayJpegQuality(quality)).toBe(true);
    expect(normalizeOverlayJpegQuality(quality)).toBe(quality);
  });

  it.each([0, 101, 92.5, '95', undefined, null])(
    'falls back for invalid quality %j',
    (quality) => {
      expect(isValidOverlayJpegQuality(quality)).toBe(false);
      expect(normalizeOverlayJpegQuality(quality)).toBe(
        DEFAULT_OVERLAY_JPEG_QUALITY
      );
    }
  );
});

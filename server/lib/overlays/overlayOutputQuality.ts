import { getSettings } from '@server/lib/settings';

export type OverlayOutputFormat = 'jpeg' | 'webp';

// JPEG carries the EXIF ownership marker Posterizarr reads. Everyone else keeps
// WebP so existing hashes and posters stay untouched.
export function overlayOutputFormat(): OverlayOutputFormat {
  return getSettings().overlays?.posterizarrIntegrationEnabled
    ? 'jpeg'
    : 'webp';
}

export const MIN_OVERLAY_JPEG_QUALITY = 1;
export const MAX_OVERLAY_JPEG_QUALITY = 100;
export const DEFAULT_OVERLAY_JPEG_QUALITY = 95;

export function isValidOverlayJpegQuality(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_OVERLAY_JPEG_QUALITY &&
    value <= MAX_OVERLAY_JPEG_QUALITY
  );
}

/** Safely read a persisted quality value written by an older/newer build. */
export function normalizeOverlayJpegQuality(value: unknown): number {
  return isValidOverlayJpegQuality(value)
    ? value
    : DEFAULT_OVERLAY_JPEG_QUALITY;
}

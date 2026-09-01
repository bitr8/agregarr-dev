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

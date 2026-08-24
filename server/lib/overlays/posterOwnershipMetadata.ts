export const AGREGARR_OVERLAY_MARKER = 'overlay applied by Agregarr';

// Keep this aligned with Posterizarr's metadata scan. Posterizarr calls these
// values EXIF in its logs, but its own generated JPEGs store the identifying
// text in a JPEG comment segment.
const RECOGNIZED_OWNERSHIP_MARKER =
  /created with posterizarr|created with ppm|titlecard|overlay/i;

/**
 * Return the marker Posterizarr would recognize in an existing poster.
 *
 * Scan the complete source so reset/restore can translate a late WebP metadata
 * chunk into early JPEG EXIF, even when Posterizarr's own 64-KiB scan would
 * otherwise miss it.
 */
export function getRecognizedPosterOwnershipMarker(
  posterBuffer: Buffer
): string | null {
  const match = posterBuffer
    .toString('latin1')
    .match(RECOGNIZED_OWNERSHIP_MARKER);
  return match?.[0].toLowerCase() ?? null;
}

export function hasAgregarrOverlayMarker(posterBuffer: Buffer): boolean {
  return posterBuffer
    .toString('latin1')
    .toLowerCase()
    .includes(AGREGARR_OVERLAY_MARKER.toLowerCase());
}

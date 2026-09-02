/**
 * Decide whether to skip uploading a poster after a render produced zero
 * overlay elements. Compositing and uploading an empty overlay set is a
 * lossy WebP re-encode of the base poster for no visual change - only worth
 * paying for when the current Plex poster is one we uploaded, where the
 * re-upload functions as overlay removal (strips a stale overlay back to
 * the base). Otherwise there is nothing to draw and nothing of ours to
 * remove.
 */
export function shouldSkipEmptyRenderUpload(
  allOverlaysCount: number,
  currentPosterIsOurs: boolean
): boolean {
  return allOverlaysCount === 0 && !currentPosterIsOurs;
}

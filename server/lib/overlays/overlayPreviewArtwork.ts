import sharp from 'sharp';
import {
  OVERLAY_ARTWORK_DIMENSIONS,
  type OverlayArtworkTarget,
} from './overlayTargets';

/**
 * Turn the available portrait sample artwork into a correctly sized preview
 * surface for the requested Plex artwork type. Episode cards use a 16:9 crop;
 * main and season artwork use the normal 2:3 poster canvas.
 */
export async function createOverlayPreviewArtwork(
  source: Buffer,
  target: OverlayArtworkTarget
): Promise<Buffer> {
  const { width, height } = OVERLAY_ARTWORK_DIMENSIONS[target];

  return sharp(source)
    .rotate()
    .resize(width, height, {
      fit: 'cover',
      position: sharp.strategy.attention,
    })
    .jpeg({ quality: 88 })
    .toBuffer();
}

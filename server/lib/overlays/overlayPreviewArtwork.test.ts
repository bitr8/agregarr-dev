import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createOverlayPreviewArtwork } from './overlayPreviewArtwork';

const createPortraitFixture = () =>
  sharp({
    create: {
      width: 300,
      height: 450,
      channels: 3,
      background: '#334155',
    },
  })
    .png()
    .toBuffer();

describe('createOverlayPreviewArtwork', () => {
  it.each([
    ['main', 1000, 1500],
    ['season', 1000, 1500],
    ['episode', 1920, 1080],
  ] as const)(
    'creates a correctly sized %s preview',
    async (target, width, height) => {
      const output = await createOverlayPreviewArtwork(
        await createPortraitFixture(),
        target
      );
      const metadata = await sharp(output).metadata();

      expect(metadata).toMatchObject({ format: 'jpeg', width, height });
    }
  );
});

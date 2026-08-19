/**
 * Element positioning: the unrotated buffer's centre is the element's anchor
 * point. sharp.rotate() expands the canvas, so a rotated element must be
 * placed by centring the expanded box where the unrotated buffer's centre
 * would sit — not by anchoring the expanded box's top-left at element.x/y.
 */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import type { OverlayElement } from '@server/entity/OverlayTemplate';

import { overlayTemplateRenderer } from './OverlayTemplateRenderer';
import { createSampleOverlayContext } from './sampleOverlayContext';

const tile = (
  rotation?: number,
  box: Partial<OverlayElement> = {}
): OverlayElement => ({
  id: 'tile-1',
  layerOrder: 0,
  type: 'tile',
  x: 100,
  y: 200,
  width: 200,
  height: 100,
  rotation,
  properties: { fillColor: '#ff0000', fillOpacity: 100 },
  ...box,
});

const renderOne = async (
  element: OverlayElement,
  posterW = 1000,
  posterH = 1500
): Promise<sharp.OverlayOptions> => {
  const overlays = await overlayTemplateRenderer.renderOverlayElements(
    posterW,
    posterH,
    { width: 1000, height: 1500, elements: [element] },
    createSampleOverlayContext('movie')
  );
  expect(overlays).toHaveLength(1);
  const overlay = overlays?.[0];
  if (!overlay) throw new Error('no overlay rendered');
  return overlay;
};

describe('overlay element positioning', () => {
  it('anchors a non-rotated element top-left at element.x/y', async () => {
    const overlay = await renderOne(tile());
    expect(overlay.left).toBe(100);
    expect(overlay.top).toBe(200);
  });

  it('keeps a 90-degree rotated element centred on the element box', async () => {
    const overlay = await renderOne(tile(90));
    // 200x100 buffer rotated 90 becomes 100x200; centre stays at (200, 250)
    expect(overlay.left).toBe(150);
    expect(overlay.top).toBe(150);
  });

  it('keeps a 45-degree rotated element centred on the element box', async () => {
    const overlay = await renderOne(tile(45));
    const meta = await sharp(overlay.input as Buffer).metadata();
    const width = meta.width ?? NaN;
    const height = meta.height ?? NaN;
    expect(width).toBeGreaterThan(200);
    expect((overlay.left ?? NaN) + Math.round(width / 2)).toBe(200);
    expect((overlay.top ?? NaN) + Math.round(height / 2)).toBe(250);
  });

  it('scales the anchor with the poster', async () => {
    const overlay = await renderOne(tile(90), 500, 750);
    // scale 0.5: element centre (100, 125); rotated buffer 50x100
    expect(overlay.left).toBe(75);
    expect(overlay.top).toBe(75);
  });

  it('adds the centering offset on a non-2:3 poster', async () => {
    const overlay = await renderOne(tile(90), 1000, 1000);
    // scale 2/3, offsetX 166.7; buffer 133x67 rotated 90 becomes 67x133
    expect(overlay.left).toBe(266);
    expect(overlay.top).toBe(100);
  });

  it('keeps an oversize-clamped element anchored at element.x/y', async () => {
    const overlay = await renderOne(
      tile(undefined, { x: 0, y: 200, width: 1400, height: 100 })
    );
    // 1400x100 buffer clamps to 1000x71; anchor shrinks with it
    expect(overlay.left).toBe(0);
    expect(overlay.top).toBe(200);
  });

  it('clamps to an odd width without float drift at the .5 boundary', async () => {
    const overlay = await renderOne(
      tile(undefined, { x: 0, y: 200, width: 1400, height: 100 }),
      999,
      1500
    );
    // buffer 1399x100 clamps to 999-wide; anchor/2 lands exactly on 499.5
    expect(overlay.left).toBe(0);
    expect(overlay.top).toBe(200);
  });
});

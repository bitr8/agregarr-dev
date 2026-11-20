import type { OverlayElement } from '@server/entity/OverlayTemplate';
import { createHash } from 'crypto';
import sharp from 'sharp';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const icons = vi.hoisted(() => ({ files: new Map<string, Buffer>() }));
vi.mock('@server/lib/iconManager', () => ({
  loadIconFile: async (filename: string) => {
    const file = icons.files.get(filename);
    if (!file) throw new Error(`missing ${filename}`);
    return file;
  },
}));

import { overlayTemplateRenderer } from './OverlayTemplateRenderer';
import { createSampleOverlayContext } from './sampleOverlayContext';

const svgIcon = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#ff0000"/></svg>'
);

const render = async (element: OverlayElement, size = 100) => {
  const overlays = await overlayTemplateRenderer.renderOverlayElements(
    size,
    size,
    { width: size, height: size, elements: [element] },
    createSampleOverlayContext('movie')
  );
  expect(overlays).toHaveLength(1);
  return overlays?.[0].input as Buffer;
};

const pixel = async (buffer: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return Array.from(data.subarray(i, i + info.channels));
};

const hash = (buffer: Buffer) =>
  createHash('sha256').update(buffer).digest('hex');

const svgEl = (props: object = {}): OverlayElement => ({
  id: 'svg',
  layerOrder: 0,
  type: 'svg',
  x: 0,
  y: 0,
  width: 40,
  height: 20,
  properties: {
    iconType: 'custom-icon',
    iconPath: '/api/v1/posters/icons/user/a.svg',
    ...props,
  },
});

const rasterEl = (props: object = {}): OverlayElement => ({
  id: 'raster',
  layerOrder: 0,
  type: 'raster',
  x: 0,
  y: 0,
  width: 30,
  height: 30,
  properties: { imagePath: '/api/v1/posters/icons/user/b.png', ...props },
});

const mappedEl = (props: object = {}): OverlayElement => ({
  id: 'mapped',
  layerOrder: 0,
  type: 'mapped-icon',
  x: 0,
  y: 0,
  width: 30,
  height: 30,
  properties: {
    field: 'resolution',
    mappings: [{ value: '4K', iconPath: '/api/v1/posters/icons/user/c.png' }],
    layout: 'horizontal',
    iconSize: 30,
    spacingX: 4,
    spacingY: 4,
    ...props,
  },
});

const tileEl = (props: object = {}): OverlayElement => ({
  id: 'tile',
  layerOrder: 0,
  type: 'tile',
  x: 0,
  y: 0,
  width: 20,
  height: 20,
  properties: { fillColor: '#0000ff', fillOpacity: 100, ...props },
});

beforeAll(async () => {
  icons.files.set('a.svg', svgIcon);
  const solid = (r: number, g: number, b: number) =>
    sharp({
      create: {
        width: 20,
        height: 10,
        channels: 4,
        background: { r, g, b, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
  icons.files.set('b.png', await solid(0, 255, 0));
  icons.files.set('c.png', await solid(255, 0, 0));
});

const BASELINE = {
  svg: '5ccd66d0e889997d85f7ad46bb5a5efb4da958473b0ea891c5f39bd4afd6680d',
  raster: '2533be8cbc243496a19bd9e1c3e40c0ed88d4ded74943bf56075fe93b6d12a43',
  mapped: 'c04e2d12b75992e6c7a969d214ffa44414e8bd181beaf8d18408c96fd5eef907',
  tile: '9e71e51475bfeae584d59aef852cfea8fc4dfe9bd2b74b8c780fa4b1dc5401ba',
};

describe('defaults leave element output byte-identical', () => {
  it('svg at opacity 100, grayscale off', async () => {
    expect(hash(await render(svgEl({ opacity: 100, grayscale: false })))).toBe(
      BASELINE.svg
    );
  });

  it('raster at opacity 100', async () => {
    expect(hash(await render(rasterEl({ opacity: 100 })))).toBe(
      BASELINE.raster
    );
  });

  it('mapped at opacity 100, grayscale off', async () => {
    expect(
      hash(await render(mappedEl({ opacity: 100, grayscale: false })))
    ).toBe(BASELINE.mapped);
  });

  it('tile without a border', async () => {
    expect(
      hash(await render(tileEl({ borderRadius: 4, lockCorners: true })))
    ).toBe(BASELINE.tile);
  });

  it('unset opacity matches opacity 100', async () => {
    expect(hash(await render(svgEl()))).toBe(BASELINE.svg);
    expect(hash(await render(rasterEl()))).toBe(BASELINE.raster);
    expect(hash(await render(mappedEl()))).toBe(BASELINE.mapped);
  });
});

describe('opacity and grayscale', () => {
  it('halves the alpha of an svg icon', async () => {
    const full = await pixel(await render(svgEl()), 20, 10);
    const half = await pixel(await render(svgEl({ opacity: 50 })), 20, 10);
    expect(full[3]).toBe(255);
    expect(half[3]).toBe(128);
    expect(half.slice(0, 3)).toEqual(full.slice(0, 3));
  });

  it('halves the alpha of a raster image', async () => {
    const half = await pixel(await render(rasterEl({ opacity: 50 })), 15, 15);
    expect(half[3]).toBe(128);
  });

  it('halves the alpha of mapped icons', async () => {
    const half = await pixel(await render(mappedEl({ opacity: 50 })), 15, 15);
    expect(half[3]).toBe(128);
  });

  it('keeps a saved opacity of 0 fully transparent', async () => {
    const none = await pixel(await render(svgEl({ opacity: 0 })), 20, 10);
    expect(none[3]).toBe(0);
  });

  it('greys an svg icon', async () => {
    const [r, g, b, a] = await pixel(
      await render(svgEl({ grayscale: true })),
      20,
      10
    );
    expect(r).toBe(g);
    expect(g).toBe(b);
    expect(r).toBeGreaterThan(0);
    expect(a).toBe(255);
  });

  it('greys and fades together', async () => {
    const [r, g, b, a] = await pixel(
      await render(svgEl({ grayscale: true, opacity: 50 })),
      20,
      10
    );
    expect(r).toBe(g);
    expect(g).toBe(b);
    expect(a).toBe(128);
  });
});

describe('tile border', () => {
  const bordered = (props: object = {}) =>
    tileEl({ borderWidth: 4, borderColor: '#ff0000', ...props });

  it('is the full border width, drawn inside the tile', async () => {
    const buffer = await render(bordered(), 20);
    for (const x of [0, 1, 2, 3]) {
      expect(await pixel(buffer, x, 10)).toEqual([255, 0, 0, 255]);
    }
    expect(await pixel(buffer, 4, 10)).toEqual([0, 0, 255, 255]);
    expect(await pixel(buffer, 10, 0)).toEqual([255, 0, 0, 255]);
    expect(await pixel(buffer, 10, 3)).toEqual([255, 0, 0, 255]);
    expect(await pixel(buffer, 10, 4)).toEqual([0, 0, 255, 255]);
  });

  it('keeps the tile size', async () => {
    const meta = await sharp(await render(bordered(), 20)).metadata();
    expect([meta.width, meta.height]).toEqual([20, 20]);
  });

  it('draws white when no border colour was stored', async () => {
    const buffer = await render(bordered({ borderColor: undefined }), 20);
    expect(await pixel(buffer, 1, 10)).toEqual([255, 255, 255, 255]);
  });
});

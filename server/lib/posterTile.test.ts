import type { LayeredElement } from '@server/entity/PosterTemplate';
import { resolveTileCornerRadii } from '@server/lib/overlays/roundedRect';
import { generateTileElement } from '@server/lib/posterGeneration';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

const tile = (
  properties: Record<string, unknown>,
  box = { x: 20, y: 30, width: 100, height: 60 }
): LayeredElement => ({
  id: 'tile-1',
  layerOrder: 1,
  type: 'tile',
  ...box,
  properties: properties as unknown as LayeredElement['properties'],
});

const pixel = async (svg: string, x: number, y: number) => {
  const { data, info } = await sharp(Buffer.from(svg))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
};

const canvas = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150">${body}</svg>`;

describe('generateTileElement', () => {
  it('draws the fill at the element position with rounded corners', async () => {
    const el = tile({
      fillColor: '#ff0000',
      fillOpacity: 100,
      borderRadiusTopLeft: 20,
      lockCorners: true,
    });
    const svg = canvas(generateTileElement(el, el.properties as never));

    expect(await pixel(svg, 70, 60)).toEqual([255, 0, 0, 255]);
    expect((await pixel(svg, 10, 10))[3]).toBe(0);
    expect((await pixel(svg, 21, 31))[3]).toBe(0);
    expect((await pixel(svg, 119, 89))[3]).toBe(0);
  });

  it('applies fill opacity', async () => {
    const el = tile({ fillColor: '#0000ff', fillOpacity: 50 });
    const svg = canvas(generateTileElement(el, el.properties as never));
    const alpha = (await pixel(svg, 70, 60))[3];
    expect(alpha).toBeGreaterThan(120);
    expect(alpha).toBeLessThan(135);
  });

  it('draws a border only when width and colour are set', () => {
    const base = { fillColor: '#000000', fillOpacity: 100 };
    const none = tile({ ...base, borderWidth: 0, borderColor: '#fff' });
    const noColor = tile({ ...base, borderWidth: 4 });
    const both = tile({ ...base, borderWidth: 4, borderColor: '#ffffff' });
    expect(generateTileElement(none, none.properties as never)).not.toContain(
      'stroke'
    );
    expect(
      generateTileElement(noColor, noColor.properties as never)
    ).not.toContain('stroke');
    expect(generateTileElement(both, both.properties as never)).toContain(
      'stroke="#ffffff" stroke-width="4"'
    );
  });

  it('escapes colour values into the attribute', () => {
    const el = tile({ fillColor: '"/><script/>', fillOpacity: 100 });
    const out = generateTileElement(el, el.properties as never);
    expect(out).not.toContain('<script');
    expect(out).toContain('&quot;');
  });
});

describe('resolveTileCornerRadii', () => {
  it('uses the legacy borderRadius for every corner', () => {
    expect(resolveTileCornerRadii({ borderRadius: 8 }, 2)).toEqual({
      topLeft: 16,
      topRight: 16,
      bottomRight: 16,
      bottomLeft: 16,
    });
  });

  it('keeps individual corners when unlocked', () => {
    expect(
      resolveTileCornerRadii({
        borderRadiusTopLeft: 5,
        borderRadiusBottomRight: 9,
      })
    ).toEqual({ topLeft: 5, topRight: 0, bottomRight: 9, bottomLeft: 0 });
  });
});

describe('generateTileElement with bad stored values', () => {
  it('never emits NaN and still draws the tile', () => {
    const el = tile({
      fillColor: 42,
      fillOpacity: 'lots',
      borderRadiusTopLeft: 'x',
      lockCorners: true,
      borderWidth: 'wide',
      borderColor: '#fff',
    });
    const out = generateTileElement(el, el.properties as never);
    expect(out).not.toContain('NaN');
    expect(out).toContain('fill="#000000"');
    expect(out).toContain('fill-opacity="1"');
    expect(out).not.toContain('stroke');
  });

  it('uses a native rounded rect when the corners match', () => {
    const el = tile({
      fillColor: '#ff0000',
      fillOpacity: 100,
      borderRadiusTopLeft: 500,
      lockCorners: true,
    });
    const out = generateTileElement(el, el.properties as never);
    expect(out).toMatch(/^<rect /);
    expect(out).toContain('rx="30"');
  });
});

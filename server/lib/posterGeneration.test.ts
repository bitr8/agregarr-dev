import { loadIconFile } from '@server/lib/iconManager';
import {
  embedSVGIconInSVG,
  generatePosterBuffer,
  renderSeasonBadge,
} from '@server/lib/posterGeneration';
import { applyTemplate } from '@server/lib/posterTemplates';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/lib/posterTemplates', () => ({
  applyTemplate: vi.fn().mockResolvedValue(Buffer.from('png')),
}));

vi.mock('@server/lib/iconManager', () => ({
  loadIconFile: vi.fn(),
}));

// A representative tile from a 3x2 grid on a 1000x1500 poster.
const W = 300;
const H = 420;

const attr = (svg: string, name: string): number => {
  const m = svg.match(new RegExp(`${name}="([-0-9.]+)"`));
  return m ? parseFloat(m[1]) : NaN;
};

describe('renderSeasonBadge', () => {
  it('renders the season number as S{n}', () => {
    expect(renderSeasonBadge(1, W, H)).toContain('>S1</text>');
    expect(renderSeasonBadge(12, W, H)).toContain('>S12</text>');
  });

  it('widens the badge for a two-digit season so the label still fits', () => {
    const oneDigit = renderSeasonBadge(1, W, H);
    const twoDigit = renderSeasonBadge(12, W, H);
    const w1 = attr(oneDigit.split('<rect')[1], 'width');
    const w2 = attr(twoDigit.split('<rect')[1], 'width');
    expect(w2).toBeGreaterThan(w1);
  });

  it('stays inside the tile bounds', () => {
    const svg = renderSeasonBadge(6, W, H);
    const rect = svg.split('<rect')[1];
    const badgeWidth = attr(rect, 'width');
    const badgeHeight = attr(rect, 'height');
    const translate = svg.match(/translate\(([-0-9.]+), ([-0-9.]+)\)/);
    expect(translate).not.toBeNull();
    const tx = parseFloat((translate as RegExpMatchArray)[1]);
    const ty = parseFloat((translate as RegExpMatchArray)[2]);

    expect(tx).toBeGreaterThanOrEqual(0);
    expect(ty).toBeGreaterThanOrEqual(0);
    expect(tx + badgeWidth).toBeLessThanOrEqual(W);
    expect(ty + badgeHeight).toBeLessThanOrEqual(H);
  });

  it('sits in the bottom-left of the tile', () => {
    const svg = renderSeasonBadge(3, W, H);
    const translate = svg.match(
      /translate\(([-0-9.]+), ([-0-9.]+)\)/
    ) as RegExpMatchArray;
    const tx = parseFloat(translate[1]);
    const ty = parseFloat(translate[2]);
    expect(tx).toBeLessThan(W / 2); // left half
    expect(ty).toBeGreaterThan(H / 2); // bottom half
  });

  it('scales with the tile', () => {
    const small = renderSeasonBadge(1, 100, 150);
    const large = renderSeasonBadge(1, 400, 600);
    expect(attr(large, 'font-size')).toBeGreaterThan(attr(small, 'font-size'));
  });

  it('emits balanced markup with a single group', () => {
    const svg = renderSeasonBadge(4, W, H);
    expect(svg.match(/<g /g)).toHaveLength(1);
    expect(svg.match(/<\/g>/g)).toHaveLength(1);
    expect(svg.match(/<rect /g)).toHaveLength(1);
    expect(svg.match(/<text /g)).toHaveLength(1);
    expect(svg.match(/<\/text>/g)).toHaveLength(1);
  });

  it('produces no NaN in any coordinate', () => {
    expect(renderSeasonBadge(9, W, H)).not.toContain('NaN');
  });
});

describe('generatePosterBuffer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the condition context fields through to applyTemplate', async () => {
    await generatePosterBuffer({
      collectionName: 'PG-13',
      collectionType: 'plex',
      collectionSubtype: 'contentRating',
      mediaType: 'movie',
      autoPosterTemplate: 42,
      items: [],
    });

    expect(applyTemplate).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        collectionName: 'PG-13',
        collectionType: 'plex',
        collectionSubtype: 'contentRating',
        mediaType: 'movie',
      })
    );
  });
});

describe('embedSVGIconInSVG', () => {
  // Trimmed from a real Inkscape export: prefixed namespaces are declared on
  // the root <svg>, so inlining its children into another SVG is malformed XML.
  const inkscapeIcon = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg
   width="92.604164mm"
   height="92.604149mm"
   viewBox="0 0 92.604164 92.604149"
   version="1.1"
   id="svg5"
   sodipodi:docname="BBFC_18_2019.svg"
   inkscape:version="1.4 (e7c3feb100, 2024-10-09)"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns="http://www.w3.org/2000/svg"
   xmlns:svg="http://www.w3.org/2000/svg">
  <sodipodi:namedview
     id="namedview5"
     pagecolor="#ffffff"
     inkscape:current-layer="svg5" />
  <defs
     id="defs1" />
  <path
     fill="#d70723"
     d="m 46.298689,5.6839984 c -22.433731,0 -40.6159126,18.1821646 -40.6159126,40.6158966 0,22.42728 18.1821816,40.615912 40.6159126,40.615912 22.433731,0 40.615913,-18.188632 40.615913,-40.615912 0,-22.433732 -18.182182,-40.6158966 -40.615913,-40.6158966"
     id="path4"
     style="fill:#dc0a0a;fill-opacity:1;stroke-width:1.6541" />
</svg>`;

  it('renders an Inkscape-exported icon into a poster sharp can rasterise', async () => {
    vi.mocked(loadIconFile).mockResolvedValue(Buffer.from(inkscapeIcon));
    const sharp = (await import('sharp')).default;

    const fragment = await embedSVGIconInSVG(
      '/api/v1/posters/icons/user/bbfc-18.svg',
      { x: 0, y: 456, width: 996, height: 526 }
    );

    expect(fragment).toContain('data:image/png;base64,');
    const poster = `<svg width="1000" height="1500" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${fragment}</svg>`;
    const { data, info } = await sharp(Buffer.from(poster))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let red = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i + 3] === 255 && data[i] > 200 && data[i + 1] < 40) red++;
    }
    // Circle area at this scale is ~167k px; a stretched or clipped icon misses the band.
    expect(red).toBeGreaterThan(150_000);
    expect(red).toBeLessThan(185_000);
  });
});

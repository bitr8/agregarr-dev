import {
  generatePosterBuffer,
  renderSeasonBadge,
} from '@server/lib/posterGeneration';
import { applyTemplate } from '@server/lib/posterTemplates';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/lib/posterTemplates', () => ({
  applyTemplate: vi.fn().mockResolvedValue(Buffer.from('png')),
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

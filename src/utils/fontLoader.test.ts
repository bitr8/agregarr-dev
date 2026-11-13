import { describe, expect, it } from 'vitest';
import { readMiddleBaseline } from './fontLoader';

const buildFont = (
  tables: { tag: string; data: (view: DataView, offset: number) => void }[]
): ArrayBuffer => {
  const dirSize = 12 + tables.length * 16;
  const buffer = new ArrayBuffer(dirSize + tables.length * 100);
  const view = new DataView(buffer);
  view.setUint16(4, tables.length);
  tables.forEach((table, i) => {
    const rec = 12 + i * 16;
    const offset = dirSize + i * 100;
    for (let c = 0; c < 4; c++) view.setUint8(rec + c, table.tag.charCodeAt(c));
    view.setUint32(rec + 8, offset);
    view.setUint32(rec + 12, 100);
    table.data(view, offset);
  });
  return buffer;
};

const head = (unitsPerEm: number) => ({
  tag: 'head',
  data: (view: DataView, offset: number) =>
    view.setUint16(offset + 18, unitsPerEm),
});

const os2 = (position: number, size: number) => ({
  tag: 'OS/2',
  data: (view: DataView, offset: number) => {
    view.setInt16(offset + 26, size);
    view.setInt16(offset + 28, position);
  },
});

describe('readMiddleBaseline', () => {
  it('matches the offset librsvg renders for Inter (36px at 100px)', () => {
    const middle = readMiddleBaseline(buildFont([os2(671, 140), head(2048)]));
    expect(middle).toBeCloseTo(0.3618, 4);
  });

  it('matches the offset librsvg renders for Bebas Neue (46px at 100px)', () => {
    const middle = readMiddleBaseline(buildFont([head(1000), os2(420, 80)]));
    expect(middle).toBeCloseTo(0.46, 4);
  });

  it('returns undefined without an OS/2 table', () => {
    expect(readMiddleBaseline(buildFont([head(1000)]))).toBeUndefined();
  });

  it('returns undefined for a zero strikeout position', () => {
    expect(
      readMiddleBaseline(buildFont([head(1000), os2(0, 50)]))
    ).toBeUndefined();
  });

  it('returns undefined for a strikeout position past the em', () => {
    expect(
      readMiddleBaseline(buildFont([head(1000), os2(30000, 50)]))
    ).toBeUndefined();
  });

  it('returns undefined for a truncated file', () => {
    expect(readMiddleBaseline(new ArrayBuffer(8))).toBeUndefined();
  });
});

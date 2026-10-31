import { assertSafeSvg } from '@server/lib/iconManager';
import { describe, expect, it } from 'vitest';

const svg = (inner: string) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${inner}</svg>`
  );

describe('assertSafeSvg', () => {
  it('accepts a plain SVG', async () => {
    await expect(
      assertSafeSvg(svg('<rect width="10" height="10" fill="red"/>'))
    ).resolves.toBeUndefined();
  });

  it.each([
    '<script>alert(1)</script>',
    '<rect onload="alert(1)" width="1" height="1"/>',
    '<a href="javascript:alert(1)"><rect width="1" height="1"/></a>',
    '<foreignObject><div/></foreignObject>',
    '<svg:script xmlns:svg="http://www.w3.org/2000/svg">alert(1)</svg:script>',
  ])('rejects %s', async (inner) => {
    await expect(assertSafeSvg(svg(inner))).rejects.toThrow();
  });

  it('rejects non-SVG content', async () => {
    await expect(assertSafeSvg(Buffer.from('not an svg'))).rejects.toThrow();
  });
});

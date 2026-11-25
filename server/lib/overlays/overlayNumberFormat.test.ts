import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({ overlays: {}, plex: { libraries: [] } }),
}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { overlayTemplateRenderer } from './OverlayTemplateRenderer';

type Segment = {
  type: string;
  value?: string;
  field?: string;
  format?: string;
};

const renderText = async (
  segments: Segment[],
  context: Record<string, unknown>
): Promise<string | null> => {
  const renderer = overlayTemplateRenderer as unknown as {
    renderVariableElement: (...a: unknown[]) => Promise<Buffer | null>;
    escapeXml: (s: string) => string;
  };
  const spy = vi.spyOn(renderer, 'escapeXml');
  const buf = await renderer.renderVariableElement(
    {
      type: 'variable',
      width: 305,
      height: 105,
      properties: {
        segments,
        fontSize: 55,
        fontFamily: 'Inter',
        fontWeight: 'normal',
        fontStyle: 'normal',
        color: '#fff',
        textAlign: 'center',
      },
    },
    1920,
    1080,
    1920,
    1080,
    context
  );
  const out = buf
    ? spy.mock.calls.map((c) => c[0] as string).find((t) => /\d/.test(t)) ??
      null
    : null;
  spy.mockRestore();
  return out;
};

const code = (format?: string): Segment[] => [
  { type: 'text', value: 'S' },
  { type: 'variable', field: 'seasonNumber', format },
  { type: 'text', value: 'E' },
  { type: 'variable', field: 'episodeNumber', format },
];

describe('variable element number format', () => {
  it('pads season and episode to 2 digits', async () => {
    expect(
      await renderText(code('pad2'), { seasonNumber: 1, episodeNumber: 5 })
    ).toBe('S01E05');
  });

  it('pads to 3 digits and leaves wider values alone', async () => {
    expect(
      await renderText(code('pad3'), { seasonNumber: 0, episodeNumber: 123 })
    ).toBe('S000E123');
  });

  it('renders unchanged with no format, an unknown format or a date format', async () => {
    for (const f of [undefined, '', 'pad9', 'MMM DD']) {
      expect(
        await renderText(code(f), { seasonNumber: 1, episodeNumber: 5 })
      ).toBe('S1E5');
    }
  });

  it('leaves ineligible fields unpadded even with a stale pad format', async () => {
    const seg = (field: string): Segment[] => [
      { type: 'variable', field, format: 'pad3' },
    ];
    expect(await renderText(seg('plexUserRating'), { plexUserRating: 8 })).toBe(
      '8'
    );
    expect(
      await renderText(seg('rtCriticsScore'), { rtCriticsScore: 88 })
    ).toBe('88');
    expect(await renderText(seg('year'), { year: 99 })).toBe('99');
  });

  it('still drops the element when a value is missing', async () => {
    expect(await renderText(code('pad2'), { seasonNumber: 1 })).toBeNull();
  });
});

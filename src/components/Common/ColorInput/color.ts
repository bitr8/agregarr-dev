const HEX_RE = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i;
const BYTE = '(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])';
const RGB_RE = new RegExp(
  `^rgb\\( *${BYTE} *, *${BYTE} *, *${BYTE} *\\)$`,
  'i'
);
const RGBA_RE = new RegExp(
  `^rgba\\( *${BYTE} *, *${BYTE} *, *${BYTE} *, *(0|1|0?\\.\\d+|1\\.0) *\\)$`,
  'i'
);

export function parseColorInput(text: string): string | null {
  const trimmed = text.trim();
  if (HEX_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  const rgbMatch = trimmed.match(RGB_RE);
  if (rgbMatch) {
    const [, r, g, b] = rgbMatch;
    return `rgb(${Number(r)},${Number(g)},${Number(b)})`;
  }

  const rgbaMatch = trimmed.match(RGBA_RE);
  if (rgbaMatch) {
    const [, r, g, b, alpha] = rgbaMatch;
    return `rgba(${Number(r)},${Number(g)},${Number(b)},${alpha.trim()})`;
  }

  return null;
}

export function toSwatchHex(value: string): string {
  const trimmed = value.trim();

  const hexMatch = trimmed.match(HEX_RE);
  if (hexMatch) {
    return `#${hexMatch[1].slice(0, 6)}`.toLowerCase();
  }

  const rgbMatch = trimmed.match(RGB_RE) || trimmed.match(RGBA_RE);
  if (rgbMatch) {
    const [, r, g, b] = rgbMatch.map(Number);
    const toHex = (n: number) => n.toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  return '#000000';
}

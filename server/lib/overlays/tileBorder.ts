import type { CornerRadii } from './roundedRect';

export const DEFAULT_TILE_BORDER_COLOR = '#FFFFFF';

export function insetTileBorder(
  width: number,
  height: number,
  radii: CornerRadii,
  borderWidth: number
): { inset: number; width: number; height: number; radii: CornerRadii } {
  const inset = borderWidth / 2;
  const shrink = (r: number) => Math.max(0, r - inset);
  return {
    inset,
    width: Math.max(0, width - borderWidth),
    height: Math.max(0, height - borderWidth),
    radii: {
      topLeft: shrink(radii.topLeft),
      topRight: shrink(radii.topRight),
      bottomRight: shrink(radii.bottomRight),
      bottomLeft: shrink(radii.bottomLeft),
    },
  };
}

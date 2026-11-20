import type { CornerRadii } from './roundedRect';

export const DEFAULT_TILE_BORDER_COLOR = '#FFFFFF';

export function insetTileBorder(
  width: number,
  height: number,
  radii: CornerRadii,
  borderWidth: number
): {
  strokeWidth: number;
  inset: number;
  width: number;
  height: number;
  radii: CornerRadii;
} {
  const strokeWidth = Math.min(borderWidth, width, height);
  const inset = strokeWidth / 2;
  const shrink = (r: number) => Math.max(0, r - inset);
  return {
    strokeWidth,
    inset,
    width: Math.max(0, width - strokeWidth),
    height: Math.max(0, height - strokeWidth),
    radii: {
      topLeft: shrink(radii.topLeft),
      topRight: shrink(radii.topRight),
      bottomRight: shrink(radii.bottomRight),
      bottomLeft: shrink(radii.bottomLeft),
    },
  };
}

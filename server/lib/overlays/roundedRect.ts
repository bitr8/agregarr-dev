export interface CornerRadii {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

interface TileCornerProps {
  borderRadius?: number;
  borderRadiusTopLeft?: number;
  borderRadiusTopRight?: number;
  borderRadiusBottomLeft?: number;
  borderRadiusBottomRight?: number;
  lockCorners?: boolean;
}

export function resolveTileCornerRadii(
  props: TileCornerProps,
  scale = 1
): CornerRadii {
  if (props.lockCorners || props.borderRadius !== undefined) {
    const r = Math.round(
      (props.borderRadiusTopLeft ?? props.borderRadius ?? 0) * scale
    );
    return { topLeft: r, topRight: r, bottomRight: r, bottomLeft: r };
  }
  const s = (v?: number) => (v ? Math.round(v * scale) : 0);
  return {
    topLeft: s(props.borderRadiusTopLeft),
    topRight: s(props.borderRadiusTopRight),
    bottomRight: s(props.borderRadiusBottomRight),
    bottomLeft: s(props.borderRadiusBottomLeft),
  };
}

export function roundedRectPath(
  width: number,
  height: number,
  radii: CornerRadii
): string {
  const max = Math.min(width / 2, height / 2);
  const tl = Math.min(radii.topLeft, max);
  const tr = Math.min(radii.topRight, max);
  const br = Math.min(radii.bottomRight, max);
  const bl = Math.min(radii.bottomLeft, max);

  return `
      M ${tl} 0
      L ${width - tr} 0
      Q ${width} 0 ${width} ${tr}
      L ${width} ${height - br}
      Q ${width} ${height} ${width - br} ${height}
      L ${bl} ${height}
      Q 0 ${height} 0 ${height - bl}
      L 0 ${tl}
      Q 0 0 ${tl} 0
      Z
    `.trim();
}

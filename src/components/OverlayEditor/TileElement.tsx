import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useRef } from 'react';
import { Group, Rect } from 'react-konva';
import type {
  ColorScale,
  OverlayElement,
  OverlayRenderContext,
  OverlayTileElementProps,
} from './types';

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

function lerpColor(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${toHex(ar + (br - ar) * t)}${toHex(ag + (bg - ag) * t)}${toHex(
    ab + (bb - ab) * t
  )}`;
}

function resolveColorScale(
  scale: ColorScale,
  context?: OverlayRenderContext
): string | null {
  if (!context) return null;
  const raw = context[scale.field];
  if (typeof raw !== 'number') return null;
  const t = Math.max(
    0,
    Math.min(1, (raw - scale.min) / (scale.max - scale.min))
  );
  if (scale.midColor) {
    return t < 0.5
      ? lerpColor(scale.fromColor, scale.midColor, t * 2)
      : lerpColor(scale.midColor, scale.toColor, (t - 0.5) * 2);
  }
  return lerpColor(scale.fromColor, scale.toColor, t);
}

interface TileElementComponentProps {
  element: OverlayElement;
  isSelected: boolean;
  renderContext?: OverlayRenderContext;
  onSelect: (node: Konva.Node) => void;
  onDragMove: (node: Konva.Node) => void;
  onDragEnd: (x: number, y: number) => void;
  onTransformEnd: (
    x: number,
    y: number,
    width: number,
    height: number,
    rotation: number
  ) => void;
}

export const TileElement: React.FC<TileElementComponentProps> = ({
  element,
  isSelected,
  renderContext,
  onSelect,
  onDragMove,
  onDragEnd,
  onTransformEnd,
}) => {
  const props = element.properties as OverlayTileElementProps;
  const fillColor =
    (props.colorScale && resolveColorScale(props.colorScale, renderContext)) ||
    props.fillColor;
  const groupRef = useRef<Konva.Group | null>(null);

  // Determine corner radii (with backward compatibility)
  let cornerRadius: number | number[];

  if (props.lockCorners || props.borderRadius !== undefined) {
    // Locked mode or legacy - all corners same
    const radius = props.borderRadiusTopLeft ?? props.borderRadius ?? 0;
    cornerRadius = radius;
  } else {
    // Unlocked mode - individual corners [top-left, top-right, bottom-right, bottom-left]
    cornerRadius = [
      props.borderRadiusTopLeft ?? 0,
      props.borderRadiusTopRight ?? 0,
      props.borderRadiusBottomRight ?? 0,
      props.borderRadiusBottomLeft ?? 0,
    ];
  }

  return (
    <Group
      ref={groupRef}
      id={element.id}
      x={element.x + element.width / 2}
      y={element.y + element.height / 2}
      offsetX={element.width / 2}
      offsetY={element.height / 2}
      width={element.width}
      height={element.height}
      rotation={element.rotation || 0}
      draggable
      onClick={() => {
        if (groupRef.current) {
          onSelect(groupRef.current);
        }
      }}
      onTap={() => {
        if (groupRef.current) {
          onSelect(groupRef.current);
        }
      }}
      onDragMove={() => {
        if (groupRef.current) {
          onDragMove(groupRef.current);
        }
      }}
      onDragEnd={(e: KonvaEventObject<DragEvent>) => {
        const node = e.target;
        onDragEnd(node.x() - element.width / 2, node.y() - element.height / 2);
      }}
      onTransformEnd={() => {
        const node = groupRef.current;
        if (node) {
          const scaleX = node.scaleX();
          const scaleY = node.scaleY();
          const rotation = node.rotation();

          const newWidth = Math.round(element.width * scaleX);
          const newHeight = Math.round(element.height * scaleY);

          node.scaleX(1);
          node.scaleY(1);

          onTransformEnd(
            node.x() - newWidth / 2,
            node.y() - newHeight / 2,
            newWidth,
            newHeight,
            rotation
          );
        }
      }}
    >
      {/* Main tile rectangle */}
      <Rect
        width={element.width}
        height={element.height}
        fill={fillColor}
        opacity={props.fillOpacity / 100}
        stroke={props.borderColor}
        strokeWidth={props.borderWidth || 0}
        cornerRadius={cornerRadius}
        listening={false}
      />

      {/* Selection indicator */}
      {isSelected && (
        <Rect
          width={element.width}
          height={element.height}
          fill="transparent"
          stroke="#ff6b35"
          strokeWidth={2}
          cornerRadius={cornerRadius}
          listening={false}
        />
      )}

      {/* Hit area for interaction */}
      <Rect
        width={element.width}
        height={element.height}
        fill="rgba(0,0,0,0.01)"
        listening={true}
      />
    </Group>
  );
};

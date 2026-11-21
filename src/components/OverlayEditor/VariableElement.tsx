import { fontLoader } from '@app/utils/fontLoader';
import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useEffect, useRef, useState } from 'react';
import { Group, Rect } from 'react-konva';
import { SingleLineText } from './SingleLineText';
import { normaliseSingleLine } from './singleLineText';
import type {
  OverlayElement,
  OverlayRenderContext,
  OverlayVariableElementProps,
} from './types';
import { buildVariableDisplayText } from './variableDisplayText';

interface VariableElementComponentProps {
  element: OverlayElement;
  renderContext?: OverlayRenderContext;
  isSelected: boolean;
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

export const VariableElement: React.FC<VariableElementComponentProps> = ({
  element,
  renderContext,
  isSelected,
  onSelect,
  onDragMove,
  onDragEnd,
  onTransformEnd,
}) => {
  const props = element.properties as OverlayVariableElementProps;
  const groupRef = useRef<Konva.Group | null>(null);
  const [fontLoaded, setFontLoaded] = useState(false);

  // Load custom font if needed
  useEffect(() => {
    if (props.fontFamily && !fontLoader.isFontLoaded(props.fontFamily)) {
      fontLoader
        .waitForFont(props.fontFamily.replace(/'/g, ''), 1000)
        .then(() => setFontLoaded(true))
        .catch(() => setFontLoaded(true)); // Continue with fallback
    } else {
      setFontLoaded(true);
    }
  }, [props.fontFamily]);

  const displayText = normaliseSingleLine(
    buildVariableDisplayText(props, renderContext)
  );

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
      opacity={(props.opacity ?? 100) / 100}
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
      {/* Hit area */}
      <Rect
        width={element.width}
        height={element.height}
        fill="rgba(0,0,0,0.01)"
        listening={true}
      />

      {fontLoaded && (
        <SingleLineText
          text={displayText}
          width={element.width}
          height={element.height}
          color={props.color}
          textAlign={props.textAlign}
          fontFamily={props.fontFamily}
          fontSize={props.fontSize}
          fontWeight={props.fontWeight}
          fontStyle={props.fontStyle}
        />
      )}

      {/* Selection indicator */}
      {isSelected && (
        <Rect
          width={element.width}
          height={element.height}
          fill="transparent"
          stroke="#ff6b35"
          strokeWidth={2}
          listening={false}
        />
      )}
    </Group>
  );
};

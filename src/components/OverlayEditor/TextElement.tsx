import { fontLoader } from '@app/utils/fontLoader';
import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useEffect, useRef, useState } from 'react';
import { Group, Rect, Shape } from 'react-konva';
import type { OverlayElement, OverlayTextElementProps } from './types';

interface TextElementComponentProps {
  element: OverlayElement;
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

export const TextElement: React.FC<TextElementComponentProps> = ({
  element,
  isSelected,
  onSelect,
  onDragMove,
  onDragEnd,
  onTransformEnd,
}) => {
  const props = element.properties as OverlayTextElementProps;
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

  // Display text (overlays just have static text)
  const displayText = (props.text || 'Sample Text')
    .replace(/[\r\n]/g, '')
    .replace(/[\t ]+/g, ' ')
    .trim();

  // Drawn like the server's SVG <text>: one line, text-anchor x, middle baseline at y=50%
  const anchorX =
    props.textAlign === 'center'
      ? element.width / 2
      : props.textAlign === 'right'
      ? element.width
      : 0;
  const font = `${props.fontStyle === 'italic' ? 'italic ' : ''}${
    props.fontWeight === 'bold' ? 'bold ' : ''
  }${props.fontSize}px "${(props.fontFamily || '').replace(/['"]/g, '')}"`;

  const [middleBaseline, setMiddleBaseline] = useState<number>();

  useEffect(() => {
    const family = (props.fontFamily || '').replace(/'/g, '');
    let active = true;
    const readMetrics = () => {
      if (active) setMiddleBaseline(fontLoader.getMiddleBaseline(family));
    };
    readMetrics();
    if (!fontLoader.isFontLoaded(family)) {
      fontLoader.waitForFont(family, 30000).then(readMetrics);
    }
    return () => {
      active = false;
    };
  }, [props.fontFamily]);

  const groupRef = useRef<Konva.Group | null>(null);

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

          // Reset scale to 1 and update width/height instead
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
      {/* Hit area - nearly transparent rect to make entire bounding box clickable */}
      <Rect
        width={element.width}
        height={element.height}
        fill="rgba(0,0,0,0.01)"
        listening={true}
      />

      {/* Text boundary box (orange checkered border) */}
      <Rect
        width={element.width}
        height={element.height}
        fill="transparent"
        stroke={isSelected ? '#ff6b35' : 'transparent'}
        strokeWidth={2}
        dash={[5, 5]}
        listening={false}
      />

      {/* Single line, centred and clipped to the box, as the server renders it */}
      {fontLoaded && (
        <Group
          clipX={0}
          clipY={0}
          clipWidth={element.width}
          clipHeight={element.height}
          listening={false}
        >
          <Shape
            width={element.width}
            height={element.height}
            listening={false}
            sceneFunc={(context) => {
              context.setAttr('font', font);
              context.setAttr('fillStyle', props.color);
              context.setAttr('textAlign', props.textAlign || 'left');
              if (middleBaseline === undefined) {
                context.setAttr('textBaseline', 'middle');
                context.fillText(displayText, anchorX, element.height / 2);
              } else {
                context.setAttr('textBaseline', 'alphabetic');
                context.fillText(
                  displayText,
                  anchorX,
                  element.height / 2 + middleBaseline * props.fontSize
                );
              }
            }}
          />
        </Group>
      )}
    </Group>
  );
};

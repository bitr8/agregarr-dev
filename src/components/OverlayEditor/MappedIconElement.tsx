import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useEffect, useMemo, useRef, useState } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import { Group, Image, Rect } from 'react-konva';
import { selectMappedIcons } from './mappedIconSelection';
import {
  isSingleValueField,
  type OverlayElement,
  type OverlayMappedIconElementProps,
  type OverlayRenderContext,
} from './types';

const messages = defineMessages({
  noMapping: {
    id: 'overlayEditor.mappedIcon.noMapping',
    defaultMessage: 'No mapping for "{value}"',
  },
});

interface MappedIconElementComponentProps {
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
  renderContext?: OverlayRenderContext;
}

interface LoadedIcon {
  image: HTMLImageElement;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MappedIconElement: React.FC<MappedIconElementComponentProps> = ({
  element,
  isSelected,
  onSelect,
  onDragMove,
  onDragEnd,
  onTransformEnd,
  renderContext,
}) => {
  const props = element.properties as OverlayMappedIconElementProps;
  const groupRef = useRef<Konva.Group | null>(null);
  const [loadedIcons, setLoadedIcons] = useState<LoadedIcon[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const isSingleField = isSingleValueField(props.field);
  const intl = useIntl();

  const { mappings: mappingsToShow, unmatchedValue } = useMemo(
    () =>
      selectMappedIcons(
        props.mappings,
        renderContext && props.field ? renderContext[props.field] : undefined,
        props.maxIcons,
        isSingleField
      ),
    [renderContext, props.field, props.mappings, props.maxIcons, isSingleField]
  );
  const isUnmatched = unmatchedValue !== undefined;
  const setTooltip = (e: KonvaEventObject<MouseEvent>, title: string) => {
    const container = e.target.getStage()?.container();
    if (container) container.title = title;
  };

  // Calculate content bounds based on icons
  // Support both new spacingX/spacingY and legacy spacing field
  const {
    iconSize,
    spacingX = props.spacing ?? 4,
    spacingY = props.spacing ?? 4,
    layout,
    gridColumns = 3,
  } = props;

  const contentBounds = useMemo(() => {
    const count = mappingsToShow.length;

    if (count === 0) return { width: iconSize, height: iconSize };

    switch (layout) {
      case 'horizontal':
        return {
          width: count * iconSize + (count - 1) * spacingX,
          height: iconSize,
        };
      case 'vertical':
        return {
          width: iconSize,
          height: count * iconSize + (count - 1) * spacingY,
        };
      case 'grid': {
        const cols = Math.min(count, gridColumns);
        const rows = Math.ceil(count / gridColumns);
        return {
          width: cols * iconSize + (cols - 1) * spacingX,
          height: rows * iconSize + (rows - 1) * spacingY,
        };
      }
      default:
        return { width: iconSize, height: iconSize };
    }
  }, [
    mappingsToShow.length,
    iconSize,
    spacingX,
    spacingY,
    layout,
    gridColumns,
  ]);

  // Load icons
  useEffect(() => {
    if (mappingsToShow.length === 0) {
      setLoadedIcons([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);

    const calcPosition = (index: number): { x: number; y: number } => {
      switch (layout) {
        case 'horizontal':
          return { x: index * (iconSize + spacingX), y: 0 };
        case 'vertical':
          return { x: 0, y: index * (iconSize + spacingY) };
        case 'grid': {
          const col = index % gridColumns;
          const row = Math.floor(index / gridColumns);
          return {
            x: col * (iconSize + spacingX),
            y: row * (iconSize + spacingY),
          };
        }
        default:
          return { x: 0, y: 0 };
      }
    };

    const loadPromises = mappingsToShow.map(
      (mapping, index) =>
        new Promise<LoadedIcon | null>((resolve) => {
          if (!mapping.iconPath) {
            resolve(null);
            return;
          }

          const img = new window.Image();
          img.onload = () => {
            const pos = calcPosition(index);

            // Calculate dimensions that fit within iconSize while preserving aspect ratio
            const naturalWidth = img.naturalWidth || img.width;
            const naturalHeight = img.naturalHeight || img.height;
            const aspectRatio = naturalWidth / naturalHeight;

            let width = iconSize;
            let height = iconSize;

            if (aspectRatio > 1) {
              // Wider than tall - fit to width
              height = iconSize / aspectRatio;
            } else if (aspectRatio < 1) {
              // Taller than wide - fit to height
              width = iconSize * aspectRatio;
            }

            // Center icon within its iconSize cell
            const offsetX = (iconSize - width) / 2;
            const offsetY = (iconSize - height) / 2;

            resolve({
              image: img,
              x: pos.x + offsetX,
              y: pos.y + offsetY,
              width,
              height,
            });
          };
          img.onerror = () => resolve(null);
          img.src = mapping.iconPath;
        })
    );

    Promise.all(loadPromises).then((results) => {
      setLoadedIcons(results.filter((r): r is LoadedIcon => r !== null));
      setIsLoading(false);
    });
  }, [mappingsToShow, iconSize, spacingX, spacingY, layout, gridColumns]);

  // Use content bounds for positioning
  const boundsWidth = contentBounds.width;
  const boundsHeight = contentBounds.height;

  // Show placeholder when no mappings or still loading
  if (props.mappings.length === 0 || isLoading) {
    return (
      <Group
        ref={groupRef}
        id={element.id}
        x={element.x + boundsWidth / 2}
        y={element.y + boundsHeight / 2}
        offsetX={boundsWidth / 2}
        offsetY={boundsHeight / 2}
        width={boundsWidth}
        height={boundsHeight}
        rotation={element.rotation || 0}
        draggable
        onClick={() => groupRef.current && onSelect(groupRef.current)}
        onTap={() => groupRef.current && onSelect(groupRef.current)}
        onDragMove={() => groupRef.current && onDragMove(groupRef.current)}
        onDragEnd={(e: KonvaEventObject<DragEvent>) => {
          const node = e.target;
          onDragEnd(node.x() - boundsWidth / 2, node.y() - boundsHeight / 2);
        }}
      >
        <Rect
          width={boundsWidth}
          height={boundsHeight}
          fill="#374151"
          stroke={isSelected ? '#ff6b35' : '#6b7280'}
          strokeWidth={2}
          strokeDashArray={[4, 4]}
        />
      </Group>
    );
  }

  return (
    <Group
      ref={groupRef}
      id={element.id}
      x={element.x + boundsWidth / 2}
      y={element.y + boundsHeight / 2}
      offsetX={boundsWidth / 2}
      offsetY={boundsHeight / 2}
      width={boundsWidth}
      height={boundsHeight}
      rotation={element.rotation || 0}
      draggable
      onClick={() => groupRef.current && onSelect(groupRef.current)}
      onTap={() => groupRef.current && onSelect(groupRef.current)}
      onMouseEnter={(e: KonvaEventObject<MouseEvent>) =>
        isUnmatched &&
        setTooltip(
          e,
          intl.formatMessage(messages.noMapping, { value: unmatchedValue })
        )
      }
      onMouseLeave={(e: KonvaEventObject<MouseEvent>) =>
        isUnmatched && setTooltip(e, '')
      }
      onDragMove={() => groupRef.current && onDragMove(groupRef.current)}
      onDragEnd={(e: KonvaEventObject<DragEvent>) => {
        const node = e.target;
        onDragEnd(node.x() - boundsWidth / 2, node.y() - boundsHeight / 2);
      }}
      onTransformEnd={() => {
        const node = groupRef.current;
        if (node) {
          const scaleX = node.scaleX();
          const scaleY = node.scaleY();
          const newWidth = Math.round(boundsWidth * scaleX);
          const newHeight = Math.round(boundsHeight * scaleY);
          node.scaleX(1);
          node.scaleY(1);
          onTransformEnd(
            node.x() - newWidth / 2,
            node.y() - newHeight / 2,
            newWidth,
            newHeight,
            node.rotation()
          );
        }
      }}
    >
      {/* Hit area */}
      <Rect width={boundsWidth} height={boundsHeight} fill="rgba(0,0,0,0.01)" />

      {/* Icons */}
      {loadedIcons.map((icon, index) => (
        <Image
          key={index}
          image={icon.image}
          x={icon.x}
          y={icon.y}
          width={icon.width}
          height={icon.height}
          opacity={((props.opacity ?? 100) / 100) * (isUnmatched ? 0.4 : 1)}
          listening={false}
        />
      ))}
    </Group>
  );
};

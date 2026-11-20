import { fontLoader } from '@app/utils/fontLoader';
import { useEffect, useState } from 'react';
import { Group, Shape } from 'react-konva';
import {
  singleLineAnchorX,
  singleLineFont,
  type SingleLineFontProps,
} from './singleLineText';

interface SingleLineTextProps extends SingleLineFontProps {
  text: string;
  width: number;
  height: number;
  color: string;
  textAlign?: string;
}

export const SingleLineText: React.FC<SingleLineTextProps> = ({
  text,
  width,
  height,
  color,
  textAlign,
  ...fontProps
}) => {
  const font = singleLineFont(fontProps);
  const anchorX = singleLineAnchorX(textAlign, width);
  const [middleBaseline, setMiddleBaseline] = useState<number>();

  useEffect(() => {
    const family = (fontProps.fontFamily || '').replace(/'/g, '');
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
  }, [fontProps.fontFamily]);

  // One line clipped to the box, like the server's SVG <text>
  return (
    <Group
      clipX={0}
      clipY={0}
      clipWidth={width}
      clipHeight={height}
      listening={false}
    >
      <Shape
        width={width}
        height={height}
        listening={false}
        sceneFunc={(context) => {
          context.setAttr('font', font);
          context.setAttr('fillStyle', color);
          context.setAttr('textAlign', textAlign || 'left');
          if (middleBaseline === undefined) {
            context.setAttr('textBaseline', 'middle');
            context.fillText(text, anchorX, height / 2);
          } else {
            context.setAttr('textBaseline', 'alphabetic');
            context.fillText(
              text,
              anchorX,
              height / 2 + middleBaseline * fontProps.fontSize
            );
          }
        }}
      />
    </Group>
  );
};

import type Konva from 'konva';
import { useEffect, useRef } from 'react';
import { Image } from 'react-konva';
import { sharpGrayscaleFilter } from './grayscaleFilter';

type FilteredImageProps = React.ComponentProps<typeof Image> & {
  grayscale?: boolean;
};

export const FilteredImage: React.FC<FilteredImageProps> = ({
  grayscale,
  ...imageProps
}) => {
  const ref = useRef<Konva.Image>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (grayscale) {
      node.filters([sharpGrayscaleFilter]);
      node.cache();
    } else {
      node.clearCache();
      node.filters([]);
    }
    node.getLayer()?.batchDraw();
  }, [grayscale, imageProps.image, imageProps.width, imageProps.height]);

  return <Image ref={ref} {...imageProps} />;
};

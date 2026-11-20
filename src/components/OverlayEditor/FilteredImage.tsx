import Konva from 'konva';
import { useEffect, useRef } from 'react';
import { Image } from 'react-konva';

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
      node.filters([Konva.Filters.Grayscale]);
      node.cache();
    } else {
      node.clearCache();
      node.filters([]);
    }
    node.getLayer()?.batchDraw();
  }, [grayscale, imageProps.image, imageProps.width, imageProps.height]);

  return <Image ref={ref} {...imageProps} />;
};

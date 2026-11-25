export type MappedIconLayout = 'horizontal' | 'vertical' | 'grid';

export function mappedIconContentSize(
  count: number,
  iconSize: number,
  spacingX: number,
  spacingY: number,
  layout: MappedIconLayout,
  gridColumns: number
): { width: number; height: number } {
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
}

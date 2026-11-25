export function containScale(
  boxWidth: number,
  boxHeight: number,
  imageWidth: number,
  imageHeight: number
): number {
  return Math.min(boxWidth / imageWidth, boxHeight / imageHeight);
}

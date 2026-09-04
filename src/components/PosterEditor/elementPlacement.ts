export function stackedY(
  base: number,
  step: number,
  count: number,
  canvasHeight: number,
  elementHeight: number
): number {
  return Math.min(
    base + count * step,
    Math.max(0, canvasHeight - elementHeight)
  );
}

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

const toSrgb = (y: number) =>
  255 * (y <= 0.0031308 ? 12.92 * y : 1.055 * Math.pow(y, 1 / 2.4) - 0.055);

export function grayLevel(r: number, g: number, b: number): number {
  const y = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  return Math.round(toSrgb(y));
}

export function sharpGrayscaleFilter(imageData: {
  data: Uint8ClampedArray;
}): void {
  const { data } = imageData;
  for (let i = 0; i < data.length; i += 4) {
    const level = grayLevel(data[i], data[i + 1], data[i + 2]);
    data[i] = level;
    data[i + 1] = level;
    data[i + 2] = level;
  }
}

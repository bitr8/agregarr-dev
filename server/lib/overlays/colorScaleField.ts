const LEGACY_COLOR_SCALE_FIELDS: Record<string, string> = {
  rtCriticRating: 'rtCriticsScore',
  rtAudienceRating: 'rtAudienceScore',
};

export function colorScaleContextField(field: string): string {
  return LEGACY_COLOR_SCALE_FIELDS[field] ?? field;
}

export function colorScaleFraction(
  raw: number,
  min: number,
  max: number
): number {
  if (!(max > min)) return raw >= min ? 1 : 0;
  return Math.max(0, Math.min(1, (raw - min) / (max - min)));
}

const LEGACY_COLOR_SCALE_FIELDS: Record<string, string> = {
  rtCriticRating: 'rtCriticsScore',
  rtAudienceRating: 'rtAudienceScore',
};

export function colorScaleContextField(field: string): string {
  return LEGACY_COLOR_SCALE_FIELDS[field] ?? field;
}

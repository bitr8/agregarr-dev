import { colorScaleContextField } from '@server/lib/overlays/colorScaleField';

export const COLOR_SCALE_FIELDS = [
  { field: 'imdbRating', label: 'IMDb Rating' },
  { field: 'tmdbRating', label: 'TMDB Rating' },
  { field: 'rtCriticsScore', label: 'RT Critic Score' },
  { field: 'rtAudienceScore', label: 'RT Audience Score' },
];

export function colorScaleFieldOptions(
  storedField: string
): { field: string; label: string }[] {
  const field = colorScaleContextField(storedField);
  return COLOR_SCALE_FIELDS.some((f) => f.field === field)
    ? COLOR_SCALE_FIELDS
    : [...COLOR_SCALE_FIELDS, { field, label: field }];
}

export function parseScaleBound(input: string, previous: number): number {
  if (input.trim() === '') return previous;
  const value = Number(input);
  return Number.isFinite(value) ? value : previous;
}

export const OVERLAY_DATE_FIELDS: readonly string[] = [
  'releaseDate',
  'theatricalReleaseDate',
  'digitalReleaseDate',
  'physicalReleaseDate',
  'nextEpisodeAirDate',
  'nextSeasonAirDate',
  'lastPlayed',
  'dateAdded',
  'lastEpisodeAddedDate',
];

export function isOverlayDateField(field: string | undefined): boolean {
  return !!field && OVERLAY_DATE_FIELDS.includes(field);
}

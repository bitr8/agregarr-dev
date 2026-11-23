import { isOverlayDateField } from '@server/lib/overlays/overlayDateFields';

export interface NumberFormatDef {
  value: string;
  label: string;
  format: (n: number) => string;
}

export const NUMBER_FORMATS: readonly NumberFormatDef[] = [
  { value: '', label: 'Plain (5)', format: (n) => n.toString() },
  {
    value: 'pad2',
    label: 'Pad to 2 digits (05)',
    format: (n) => n.toString().padStart(2, '0'),
  },
  {
    value: 'pad3',
    label: 'Pad to 3 digits (005)',
    format: (n) => n.toString().padStart(3, '0'),
  },
];

export const NUMBER_FORMAT_FIELDS: readonly string[] = [
  'seasonNumber',
  'episodeNumber',
  'totalSeasons',
  'seasonsAvailable',
  'missingEpisodeCount',
  'episodeCount',
  'episode4kCount',
  'episodeHdCount',
  'episodeSdCount',
  'episodeUnknownResolutionCount',
  'episodeHdrCount',
  'episodeDvCount',
  'episodeMultiVersionCount',
  'versionCount',
  'daysAgo',
  'daysUntilRelease',
  'daysUntilNextEpisode',
  'daysUntilNextSeason',
  'daysSinceLastAiredEpisode',
  'episodesAiringToday',
  'todaySeasonNumber',
  'todayEpisodeNumber',
  'lastAiredSeasonNumber',
  'lastAiredEpisodeNumber',
  'lastAiredEpisodeCount',
  'nextEpisodeCount',
  'nextFinaleSeasonNumber',
  'nextFinaleEpisodeNumber',
  'daysUntilNextFinale',
  'daysSinceLastFinale',
  'daysSinceAdded',
  'daysSinceLastPlayed',
  'daysSinceLastEpisodeAdded',
  'viewCount',
  'imdbTop250Rank',
];

export function isOverlayNumberFormatField(field: string | undefined): boolean {
  return !!field && NUMBER_FORMAT_FIELDS.includes(field);
}

function formatFitsField(
  field: string | undefined,
  format: string | undefined
): boolean {
  if (!format) return true;
  if (isOverlayNumberFormatField(field)) {
    return NUMBER_FORMATS.some((f) => f.value === format);
  }
  if (isOverlayDateField(field)) {
    return !NUMBER_FORMATS.some((f) => f.value === format);
  }
  return false;
}

export function mergeSegmentUpdate<
  T extends { field?: string; format?: string }
>(segment: T, updates: Partial<T>): T {
  const merged = { ...segment, ...updates };
  if ('field' in updates && !('format' in updates)) {
    if (!formatFitsField(merged.field, merged.format)) {
      merged.format = undefined;
    }
  }
  return merged;
}

export function formatNumberSegment(
  value: number,
  format: string | undefined,
  field: string | undefined
): string {
  const def =
    format && isOverlayNumberFormatField(field)
      ? NUMBER_FORMATS.find((f) => f.value === format)
      : undefined;
  if (!def || !Number.isInteger(value) || value < 0) return value.toString();
  return def.format(value);
}

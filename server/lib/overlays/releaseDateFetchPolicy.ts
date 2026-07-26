/**
 * Context fields whose values are produced by fetchReleaseDateInfo (TMDB, with a
 * Sonarr fallback for TV). If a library's enabled overlays require any of these,
 * a transient failure of that fetch must skip the item rather than re-render
 * without the field - which would strip a date-driven overlay (fork#35).
 */
export const RELEASE_DATE_CONTEXT_FIELDS = [
  'releaseDate',
  'isEstimatedReleaseDate',
  'daysUntilRelease',
  'daysAgo',
  'nextEpisodeAirDate',
  'daysUntilNextEpisode',
  'nextSeasonAirDate',
  'daysUntilNextSeason',
  'daysAgoNextSeason',
  // For show-level items these come only from fetchReleaseDateInfo, so a
  // "Next: S{seasonNumber}E{episodeNumber}" overlay still strips on a transient
  // failure without them. Matches the pre-existing "needs release-date" check.
  'seasonNumber',
  'episodeNumber',
] as const;

/**
 * Decide whether a transient release-date fetch failure should skip overlay
 * application for an item.
 *
 * Mirrors the scoping of the IMDb `criticalApiFailed` guard: skip only when the
 * library's overlays actually depend on a release-date field (or when the
 * required-field set is unknown, staying conservative). Skipping on every
 * date-API blip would invert fork#35 - a genuinely date-less show would never
 * clear a stale countdown, and unrelated base-poster / quality-badge updates
 * would be blocked for that item on any TMDB hiccup.
 *
 * @param requiredFields - The library's required context fields, or undefined
 *   when not yet computed (treated as "could need it").
 */
export function shouldSkipOnReleaseDateFetchFailure(
  requiredFields: Set<string> | undefined
): boolean {
  if (!requiredFields) {
    return true;
  }
  return RELEASE_DATE_CONTEXT_FIELDS.some((field) => requiredFields.has(field));
}

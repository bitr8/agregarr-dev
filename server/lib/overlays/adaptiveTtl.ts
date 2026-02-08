import { getSettings } from '@server/lib/settings';

/**
 * Calculate adaptive TTL for rating/release date caches based on content age.
 * Older content has more stable data, so we cache it longer.
 * TTL scales proportionally based on the ratingsCacheMaxDays setting.
 *
 * @param releaseYear - The release year of the content
 * @param maxDays - Override for max cache days (defaults to settings value or 30)
 * @returns TTL in seconds
 */
export function getAdaptiveTtl(
  releaseYear: number | undefined,
  maxDays?: number
): number {
  const effectiveMaxDays =
    maxDays ?? getSettings().main.ratingsCacheMaxDays ?? 30;
  const maxSeconds = effectiveMaxDays * 24 * 60 * 60;

  if (!releaseYear) {
    // 10% of max (3 days when max is 30) for unknown content
    return Math.round(maxSeconds * 0.1);
  }

  const currentYear = new Date().getFullYear();
  const age = currentYear - releaseYear;

  if (age < 1) {
    // ~1.7% of max (12 hours when max is 30) for new releases
    return Math.round(maxSeconds * 0.0167);
  }
  if (age < 2) {
    // 10% of max (3 days when max is 30) for recent content
    return Math.round(maxSeconds * 0.1);
  }
  if (age < 10) {
    // ~23% of max (7 days when max is 30) for older content
    return Math.round(maxSeconds * 0.233);
  }
  // 100% of max for archive content (>10 years, ratings stable)
  return maxSeconds;
}

/**
 * Get adaptive TTL for null (no data) results based on content age.
 * Shorter for new/upcoming content (data may appear soon),
 * longer for old content (unlikely to get new data now).
 * Scales based on ratingsCacheMaxDays setting (max 24h for null results).
 *
 * @param releaseYear - The release year of the content
 * @param maxDays - Override for max cache days (defaults to settings value or 30)
 * @returns TTL in seconds
 */
export function getNullRatingTtl(
  releaseYear: number | undefined,
  maxDays?: number
): number {
  const effectiveMaxDays =
    maxDays ?? getSettings().main.ratingsCacheMaxDays ?? 30;
  // Null ratings max out at 24 hours regardless of setting
  // Scale from 2h to 24h based on content age
  const baseMaxHours = Math.min(24, effectiveMaxDays * 0.8);

  if (!releaseYear) {
    // 25% of base max (6 hours when max=30) for unknown
    return Math.round(baseMaxHours * 0.25 * 60 * 60);
  }

  const currentYear = new Date().getFullYear();
  const age = currentYear - releaseYear;

  if (age < 0) {
    // ~8% of base max (2 hours when max=30) for upcoming
    return Math.round(baseMaxHours * 0.083 * 60 * 60);
  }
  if (age < 1) {
    // ~17% of base max (4 hours when max=30) for new releases
    return Math.round(baseMaxHours * 0.167 * 60 * 60);
  }
  if (age < 2) {
    // 50% of base max (12 hours when max=30) for recent
    return Math.round(baseMaxHours * 0.5 * 60 * 60);
  }
  // 100% of base max (24 hours when max=30) for older content
  return Math.round(baseMaxHours * 60 * 60);
}

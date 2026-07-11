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
  // Clamp: the setting is sometimes stored as a string ("14"), and 0 would make
  // node-cache treat the TTL as "never expire" (the opposite of the intent).
  const effectiveMaxDays = Math.max(
    1,
    Number(maxDays ?? getSettings().main.ratingsCacheMaxDays ?? 30) || 30
  );
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
 * Cap TTL for items with release dates near today.
 * TMDB release dates can shift, so items releasing within ±7 days
 * should refresh more frequently to avoid stale overlay text.
 *
 * @param releaseDate - ISO date string (YYYY-MM-DD) of the release
 * @param baseTtl - The TTL from getAdaptiveTtl (based on year)
 * @returns Capped TTL in seconds (2h within ±3 days, 4h within ±7 days)
 */
export function capTtlForRecentRelease(
  releaseDate: string | undefined,
  baseTtl: number
): number {
  if (!releaseDate) return baseTtl;

  const now = new Date();
  const dateOnly = releaseDate.split('T')[0];
  const release = new Date(dateOnly + 'T12:00:00.000Z');
  const daysDiff = Math.floor(
    Math.abs(now.getTime() - release.getTime()) / (1000 * 60 * 60 * 24)
  );

  if (daysDiff <= 3) {
    return Math.min(baseTtl, 2 * 60 * 60); // 2 hours
  }
  if (daysDiff <= 7) {
    return Math.min(baseTtl, 4 * 60 * 60); // 4 hours
  }
  return baseTtl;
}

/**
 * Cap TTL so a cached *upcoming* date (a show's next episode / next season air
 * date) cannot outlive the date it describes.
 *
 * The adaptive TTL is derived from the content's release YEAR, so an ongoing
 * show gets a multi-day TTL. But the value being cached is the next episode air
 * date, which expires within days. Once that date passes, `daysUntilNextEpisode`
 * silently computes to undefined and any overlay keyed on it drops until the TTL
 * finally expires (or the process restarts, since this is an in-memory cache) -
 * the fork#35 flip-flop. Expiring the entry shortly after the air date forces a
 * refresh that picks up the new next-episode date instead.
 *
 * @param upcomingDate - ISO date string of the upcoming air date
 * @param baseTtl - TTL in seconds from getAdaptiveTtl / capTtlForRecentRelease
 * @returns Capped TTL in seconds (never longer than baseTtl)
 */
export function capTtlForUpcomingDate(
  upcomingDate: string | undefined,
  baseTtl: number
): number {
  if (!upcomingDate) return baseTtl;

  const target = new Date(upcomingDate).getTime();
  if (Number.isNaN(target)) return baseTtl;

  // Keep the entry through the air day (when "days until" is still >= 0) and
  // give TMDB a few hours to advance next_episode_to_air, then expire.
  const bufferSeconds = 4 * 60 * 60; // 4 hours
  // Never cache a stale/past upcoming date for long, but avoid hammering TMDB
  // when it is briefly behind on advancing the next episode.
  const minTtlSeconds = 30 * 60; // 30 minutes

  const secondsUntil = Math.floor((target - Date.now()) / 1000);
  const cap = secondsUntil + bufferSeconds;
  if (cap <= minTtlSeconds) {
    return Math.min(baseTtl, minTtlSeconds);
  }
  return Math.min(baseTtl, cap);
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
  // Clamp: the setting is sometimes stored as a string ("14"), and 0 would make
  // node-cache treat the TTL as "never expire" (the opposite of the intent).
  const effectiveMaxDays = Math.max(
    1,
    Number(maxDays ?? getSettings().main.ratingsCacheMaxDays ?? 30) || 30
  );
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

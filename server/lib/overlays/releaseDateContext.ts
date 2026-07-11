import {
  calculateDaysSince,
  toServerCalendarDate,
} from '@server/utils/dateHelpers';
import type { ReleaseDateInfo } from './OverlayContextBuilder';
import type { OverlayRenderContext } from './OverlayTemplateRenderer';

/**
 * Derive the release-date render context (the day-count fields) from resolved
 * ReleaseDateInfo, applying the fork#35 read-time guarantee.
 *
 * fetchReleaseDateInfo already resolved the freshest available next-episode date
 * (Sonarr-first). If that date is still in the PAST at render time, the episode
 * has aired and no next episode is known, so the countdown is cleared:
 * `nextEpisodeAirDate` and `daysUntilNextEpisode` are omitted rather than
 * rendering "in N days" from a passed date or leaving a stale date in the
 * context. This makes the no-stale-countdown property hold independent of any
 * TTL, cache, or clock issue upstream of the render.
 *
 * A past `nextSeasonAirDate` is retained: some overlays legitimately show
 * "N days ago" via `daysAgoNextSeason`, so only the forward countdown clears.
 *
 * Pure and deterministic under a fixed clock (calculateDaysSince reads getNow),
 * so it is unit-testable with fake timers and shared by every consumer that
 * turns ReleaseDateInfo into render context (overlay sync + the test route),
 * which previously duplicated this logic and could diverge.
 */
export function deriveReleaseDateContext(
  info: ReleaseDateInfo
): Partial<OverlayRenderContext> {
  let daysUntilRelease: number | undefined;
  let daysAgo: number | undefined;
  let daysUntilNextEpisode: number | undefined;
  let daysUntilNextSeason: number | undefined;
  let daysAgoNextSeason: number | undefined;

  // A Sonarr air date carries a UTC time; classify it by its server-timezone
  // calendar date so a countdown never clears a day early near midnight.
  if (info.releaseDate) {
    const daysSince = calculateDaysSince(
      toServerCalendarDate(info.releaseDate)
    );
    if (daysSince < 0) {
      daysUntilRelease = -daysSince;
    } else {
      daysAgo = daysSince;
    }
  }

  // fork#35 read-time guarantee: clear a next-episode countdown whose date has
  // already passed (episode aired, nothing next known). Sonarr-first upstream
  // already had its chance to supply a fresher date.
  let nextEpisodeAirDate = info.nextEpisodeAirDate;
  if (nextEpisodeAirDate) {
    const daysSince = calculateDaysSince(
      toServerCalendarDate(nextEpisodeAirDate)
    );
    if (daysSince <= 0) {
      // Math.max(0, ...) keeps the count a canonical non-negative integer
      // (an airing-today date makes -daysSince a negative zero otherwise).
      daysUntilNextEpisode = Math.max(0, -daysSince);
    } else {
      nextEpisodeAirDate = undefined;
    }
  }

  if (info.nextSeasonAirDate) {
    const daysSince = calculateDaysSince(
      toServerCalendarDate(info.nextSeasonAirDate)
    );
    if (daysSince <= 0) {
      daysUntilNextSeason = Math.max(0, -daysSince);
    } else {
      daysAgoNextSeason = daysSince;
    }
  }

  return {
    releaseDate: info.releaseDate,
    daysUntilRelease,
    daysAgo,
    nextEpisodeAirDate,
    daysUntilNextEpisode,
    nextSeasonAirDate: info.nextSeasonAirDate,
    daysUntilNextSeason,
    daysAgoNextSeason,
    seasonNumber: info.seasonNumber,
    episodeNumber: info.episodeNumber,
  };
}

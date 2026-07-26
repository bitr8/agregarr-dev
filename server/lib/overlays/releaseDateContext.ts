import {
  calculateDaysSince,
  isAirDateUpcoming,
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

  // releaseDate is a coarse "released / releases in N days" marker, effectively
  // always a bare TMDB date, and it never clears an overlay (it only flips
  // between daysUntil and daysAgo), so calendar-day granularity is intentional
  // here. toServerCalendarDate keeps it correct if it ever carries a time.
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

  // fork#35 read-time guarantee: clear a next-episode countdown that is no
  // longer upcoming (a datetime past its airing instant, or a bare date past its
  // calendar day). Sonarr-first upstream already had its chance to supply a
  // fresher date, so this means the episode aired and nothing next is known.
  let nextEpisodeAirDate = info.nextEpisodeAirDate;
  if (nextEpisodeAirDate) {
    if (isAirDateUpcoming(nextEpisodeAirDate)) {
      // Day-granular count (Math.max keeps an airing-today date a canonical 0,
      // not negative zero).
      daysUntilNextEpisode = Math.max(
        0,
        -calculateDaysSince(toServerCalendarDate(nextEpisodeAirDate))
      );
    } else {
      nextEpisodeAirDate = undefined;
    }
  }

  // Symmetric with nextEpisode: a season premiere past its airing instant flips
  // to "days ago" rather than reporting "premieres today" for the rest of the
  // local day. The day-granular counts still use the tz calendar date.
  if (info.nextSeasonAirDate) {
    if (isAirDateUpcoming(info.nextSeasonAirDate)) {
      daysUntilNextSeason = Math.max(
        0,
        -calculateDaysSince(toServerCalendarDate(info.nextSeasonAirDate))
      );
    } else {
      daysAgoNextSeason = calculateDaysSince(
        toServerCalendarDate(info.nextSeasonAirDate)
      );
    }
  }

  return {
    releaseDate: info.releaseDate,
    // Only meaningful alongside a date; an estimate flag with no date to
    // qualify would let a template render "estimated" over nothing.
    isEstimatedReleaseDate: info.releaseDate ? info.isEstimated : undefined,
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

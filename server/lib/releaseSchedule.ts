import TheMovieDb from '@server/api/themoviedb';
import cacheManager from '@server/lib/cache';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import {
  calculateDaysSince,
  determineReleaseDate,
  extractReleaseDates,
  isAirDateUpcoming,
  isDateInFuture,
  toServerCalendarDate,
} from '@server/utils/dateHelpers';
import {
  capTtlForRecentRelease,
  getAdaptiveTtl,
  getNullRatingTtl,
} from './overlays/adaptiveTtl';
import type { ReleaseDateInfo } from './overlays/OverlayContextBuilder';

/**
 * Single owner of cached TMDB release / next-episode data (fork#35 Unit C).
 *
 * Before this module three code paths each fetched `getMovie` / `getTvShow` and
 * cached the result with their own TTL and failure policy:
 *   - OverlayLibraryService.prefetchTmdbReleaseDates (batch + L2 instance map)
 *   - OverlayContextBuilder.fetchReleaseDateInfo (per-item live branch, uncached)
 *   - PlaceholderContextService.fetchReleaseDate (private 24 h map)
 * That divergence is exactly what let a stale next-episode date survive in one
 * consumer while another had refreshed it. This module makes the TMDB fetch,
 * the record shape, the TTL matrix, in-flight de-duplication, and stale-if-error
 * a single policy that every consumer shares.
 *
 * Scope is deliberately TMDB-only. Sonarr-first authority for the volatile
 * next-episode field (fork#35 §4.3) stays in the overlay consumer, which owns
 * the per-job Sonarr snapshot; this module never talks to Sonarr. The read-time
 * "clear a passed countdown" guarantee stays in `deriveReleaseDateContext`.
 */

/** Which store served the record, for logging and tests. */
export type ReleaseScheduleSource = 'cache' | 'live' | 'stale';

/**
 * Discriminated result so consumers can tell three cases apart instead of
 * collapsing them to undefined (the fork#35 failure-vs-empty confusion):
 *  - 'data':   TMDB has usable release info (may be sparse: identity /
 *              first_air_date only, with no upcoming date).
 *  - 'empty':  TMDB authoritatively has NO usable release info (a movie with no
 *              release date). Cached with a short/status-aware TTL; a caller
 *              reads it as "no date", NOT as a failure.
 *  - 'failed': the live fetch threw and no serve-able stale record exists, so
 *              the answer is UNKNOWN. Callers must skip rather than strip a
 *              date-driven overlay on a transient outage (fork#35 Mechanism 2).
 */
export type ReleaseScheduleResult =
  | {
      kind: 'data';
      info: ReleaseDateInfo;
      tmdbStatus?: string;
      isEstimatedReleaseDate?: boolean;
      fetchedAt: number;
      source: ReleaseScheduleSource;
    }
  | {
      kind: 'empty';
      tmdbStatus?: string;
      fetchedAt: number;
      source: ReleaseScheduleSource;
    }
  | { kind: 'failed' };

export interface GetReleaseScheduleOptions {
  /** Region for release-date extraction. Defaults to the settings value. */
  region?: string;
  /** Release year, used only to size the movie TTL curve. */
  year?: number;
}

/**
 * The record persisted in the `tmdb-releases` NodeCache. NodeCache holds it for
 * {@link HARD_TTL_SECONDS} (the stale-if-error window); `softTtlSeconds` is the
 * shorter freshness bound enforced in this module against `fetchedAt`, so an
 * entry can be soft-stale (triggers a refresh) while still being held for
 * stale-if-error if that refresh throws.
 */
interface ReleaseScheduleRecord {
  info: ReleaseDateInfo | null;
  tmdbStatus?: string;
  isEstimatedReleaseDate?: boolean;
  /** Reserved for C4 (If-None-Match); unused for now. */
  etag?: string;
  fetchedAt: number;
  softTtlSeconds: number;
}

/** Intermediate extraction result before it is turned into a stored record. */
interface TmdbExtraction {
  info: ReleaseDateInfo | null;
  tmdbStatus?: string;
  isEstimatedReleaseDate?: boolean;
}

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

/**
 * NodeCache TTL for every record: the RFC 5861 stale-if-error window. Freshness
 * is governed by the per-record soft TTL, not this value.
 */
const HARD_TTL_SECONDS = 7 * DAY;

/**
 * In-flight de-duplication: overlapping quick-sync / collection / library jobs
 * asking for the same title share one TMDB fetch instead of racing N identical
 * requests (cache the Promise, not just the result). Keyed by the cache key.
 */
const inflight = new Map<string, Promise<ReleaseScheduleResult>>();

function cacheKeyFor(
  tmdbId: number,
  mediaType: 'movie' | 'show',
  region: string
): string {
  return `${tmdbId}:${mediaType}:${region}`;
}

function ratingsCacheMaxDays(): number {
  // Same clamp as adaptiveTtl: the setting is sometimes a string, and 0 would
  // make node-cache treat the TTL as "never expire".
  return Math.max(
    1,
    Number(getSettings().main.ratingsCacheMaxDays ?? 30) || 30
  );
}

/**
 * Seconds until an air date, for TTL banding. Returns null for an unparseable
 * date so the caller can fall back to a sane (no-event) TTL instead of banding
 * on NaN (which would make every lookup treat the record as soft-stale and
 * refetch every job - a request loop).
 *
 * A datetime is banded by its exact instant. A bare date is banded by its
 * server-timezone calendar day (day granularity) - the SAME semantics
 * `isAirDateUpcoming` uses for "is this still upcoming" - so a "today"/"tomorrow"
 * bare date is not mis-banded by a raw UTC-midnight interpretation (the fork#35
 * class of TZ-parsing divergence).
 */
function secondsUntilEvent(dateStr: string): number | null {
  if (dateStr.includes('T')) {
    const t = new Date(dateStr).getTime();
    return Number.isNaN(t) ? null : Math.floor((t - Date.now()) / 1000);
  }
  const daysSince = calculateDaysSince(toServerCalendarDate(dateStr));
  return Number.isFinite(daysSince) ? -daysSince * DAY : null;
}

/**
 * Whether every forward-looking event date in a record is still upcoming. Used
 * to gate stale-if-error: a stale record whose next-episode/next-season date has
 * already PASSED is useless for a countdown (the read-time derivation would clear
 * it anyway), so it must not be re-served - serving it would recreate the
 * fork#35 stale-countdown bug on the failure path (§4.5 rule 2). `releaseDate` is
 * a coarse "released / releases in N days" marker that never clears an overlay,
 * so it is not treated as an expiring event date here.
 */
function everyEventDateUpcoming(info: ReleaseDateInfo | null): boolean {
  if (!info) return true; // no dates -> nothing to expire
  for (const date of [info.nextEpisodeAirDate, info.nextSeasonAirDate]) {
    if (date && !isAirDateUpcoming(date)) return false;
  }
  return true;
}

/**
 * Write-time soft TTL (§4.4). TV uses the proximity-band + status-aware matrix;
 * movies keep the existing age-based curve capped for near-release dates (a
 * conservative choice: the shipped movie freshness is a strict superset of the
 * plan's coarser "12 h within +/-14 d", and this refactor is about the TV
 * countdown path, so movie behaviour is left byte-for-byte unchanged).
 */
function computeSoftTtlSeconds(
  mediaType: 'movie' | 'show',
  info: ReleaseDateInfo,
  tmdbStatus: string | undefined,
  year: number | undefined
): number {
  if (mediaType === 'show') {
    const nextDate = info.nextEpisodeAirDate;
    const secondsUntil = nextDate != null ? secondsUntilEvent(nextDate) : null;
    // A parseable upcoming/past date bands by proximity; a null (missing OR
    // unparseable) date falls through to the status-aware empty TTL below.
    if (secondsUntil !== null) {
      const daysUntil = secondsUntil / DAY;

      // Bands are lower-inclusive on the upper edge (7 d -> 24 h, matching the
      // §4.4 "7-14 d" row; exactly 1 d -> 12 h; > 14 d -> 3 d).
      let stateTtl: number;
      if (secondsUntil < 0) {
        stateTtl = 6 * HOUR; // aired, TMDB not yet advanced -> short retry
      } else if (daysUntil > 14) {
        stateTtl = 3 * DAY;
      } else if (daysUntil >= 7) {
        stateTtl = 24 * HOUR;
      } else if (daysUntil >= 1) {
        stateTtl = 12 * HOUR;
      } else {
        stateTtl = 6 * HOUR; // < 24 h; Sonarr supplies the precise timing anyway
      }

      // Hard event ceiling: never store a date past ~its airing. Floored at 6 h
      // so a soon/just-passed event still gets a sane retry cadence. With the
      // current bands stateTtl is always <= this ceiling, so it is a guard
      // against a future band-tuning pass rather than a live constraint today.
      const eventCeiling = Math.max(6 * HOUR, secondsUntil + 6 * HOUR);
      return Math.min(stateTtl, eventCeiling);
    }

    // No upcoming episode: cache the authoritative-empty answer status-awarely
    // (A2) instead of re-fetching every job. Returning/in-production shows may
    // announce a date within a day; ended/canceled rarely resurrect.
    const status = (tmdbStatus ?? '').toLowerCase();
    if (
      status.includes('ended') ||
      status.includes('canceled') ||
      status.includes('cancelled')
    ) {
      return Math.min(7 * DAY, ratingsCacheMaxDays() * DAY);
    }
    return 24 * HOUR;
  }

  // Movie: keep the existing adaptive curve, capped near release.
  return capTtlForRecentRelease(info.releaseDate, getAdaptiveTtl(year));
}

function toResult(
  record: ReleaseScheduleRecord,
  source: ReleaseScheduleSource
): ReleaseScheduleResult {
  if (record.info === null) {
    return {
      kind: 'empty',
      tmdbStatus: record.tmdbStatus,
      fetchedAt: record.fetchedAt,
      source,
    };
  }
  return {
    kind: 'data',
    info: record.info,
    tmdbStatus: record.tmdbStatus,
    isEstimatedReleaseDate: record.isEstimatedReleaseDate,
    fetchedAt: record.fetchedAt,
    source,
  };
}

/**
 * Extract the canonical release info from TMDB. This is the single copy of the
 * logic the three consumers previously duplicated (movie digital>physical>
 * theatrical, TV next_episode with a seasons-premiere fallback). TMDB-only; the
 * seasons fallback and Sonarr-first inversion that follow are the consumer's job.
 */
async function extractFromTmdb(
  tmdbId: number,
  mediaType: 'movie' | 'show',
  region: string
): Promise<TmdbExtraction> {
  const tmdb = new TheMovieDb();

  if (mediaType === 'movie') {
    const movie = await tmdb.getMovie({ movieId: tmdbId });

    if (movie.release_dates?.results) {
      const extracted = extractReleaseDates(
        movie.release_dates.results,
        region
      );
      const determined = determineReleaseDate(
        extracted.digitalRelease,
        extracted.physicalRelease,
        extracted.inCinemas
      );
      if (determined) {
        return {
          info: { releaseDate: determined.releaseDate },
          isEstimatedReleaseDate: determined.isEstimated,
        };
      }
    }

    if (movie.release_date) {
      return {
        info: { releaseDate: movie.release_date },
        isEstimatedReleaseDate: false,
      };
    }

    // Authoritative empty: TMDB knows the movie but has no release date.
    return { info: null };
  }

  // TV show.
  const show = await tmdb.getTvShow({ tvId: tmdbId });
  const tvdbId = show.external_ids?.tvdb_id;
  const tmdbStatus = show.status;
  const nextEpisode = show.next_episode_to_air;

  const info: ReleaseDateInfo = {
    releaseDate: show.first_air_date || undefined,
    tvdbId,
  };

  if (nextEpisode?.air_date) {
    info.releaseDate = show.first_air_date || nextEpisode.air_date;
    info.nextEpisodeAirDate = nextEpisode.air_date;
    info.seasonNumber = nextEpisode.season_number;
    info.episodeNumber = nextEpisode.episode_number;
    info.nextSeasonAirDate =
      nextEpisode.episode_number === 1 ? nextEpisode.air_date : undefined;
    return { info, tmdbStatus };
  }

  // No next_episode_to_air: use the earliest upcoming TMDB season as a premiere
  // (shows in Plex not yet tracked in Sonarr / not yet in next_episode).
  if (show.seasons && show.seasons.length > 0) {
    const sortedSeasons = [...show.seasons]
      .filter((s) => s.season_number > 0) // exclude specials
      .sort((a, b) => a.season_number - b.season_number);
    for (const season of sortedSeasons) {
      if (season.air_date && isDateInFuture(season.air_date)) {
        return {
          info: {
            releaseDate: show.first_air_date || season.air_date,
            nextEpisodeAirDate: season.air_date,
            // Season air date = episode 1 air date, so this is a premiere.
            nextSeasonAirDate: season.air_date,
            seasonNumber: season.season_number,
            episodeNumber: 1,
            tvdbId,
          },
          tmdbStatus,
        };
      }
    }
  }

  // Nothing upcoming; keep identity (first_air_date + tvdbId) so the overlay
  // consumer can still run Sonarr-first and the read-time derivation.
  return { info, tmdbStatus };
}

async function fetchAndStore(
  tmdbId: number,
  mediaType: 'movie' | 'show',
  region: string,
  key: string,
  year: number | undefined
): Promise<ReleaseScheduleResult> {
  const cache = cacheManager.getCache('tmdb-releases').data;
  // May be present but soft-stale; retained only for stale-if-error.
  const staleRecord = cache.get<ReleaseScheduleRecord>(key);

  try {
    const extraction = await extractFromTmdb(tmdbId, mediaType, region);

    const softTtlSeconds =
      extraction.info === null
        ? getNullRatingTtl(year)
        : computeSoftTtlSeconds(
            mediaType,
            extraction.info,
            extraction.tmdbStatus,
            year
          );

    const record: ReleaseScheduleRecord = {
      info: extraction.info,
      tmdbStatus: extraction.tmdbStatus,
      isEstimatedReleaseDate: extraction.isEstimatedReleaseDate,
      fetchedAt: Date.now(),
      softTtlSeconds,
    };
    cache.set(key, record, HARD_TTL_SECONDS);
    return toResult(record, 'live');
  } catch (error) {
    // §4.5: NEVER write null on a transient failure - that would strip a
    // date-driven overlay until the null TTL expires. Serve the last record if
    // it is still within the hard window AND none of its event dates have
    // passed; otherwise report 'failed' so the caller skips (keeps the poster).
    if (
      staleRecord &&
      Date.now() - staleRecord.fetchedAt < HARD_TTL_SECONDS * 1000 &&
      everyEventDateUpcoming(staleRecord.info)
    ) {
      logger.debug('Release schedule: serving stale record after TMDB error', {
        label: 'ReleaseSchedule',
        tmdbId,
        mediaType,
        ageMs: Date.now() - staleRecord.fetchedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      return toResult(staleRecord, 'stale');
    }

    logger.debug('Release schedule: fetch failed, no usable stale record', {
      label: 'ReleaseSchedule',
      tmdbId,
      mediaType,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: 'failed' };
  }
}

/**
 * Get cached TMDB release / next-episode info for a title.
 *
 * Fresh cache hit -> returns immediately. Soft-stale or missing -> a single
 * de-duplicated live fetch refreshes the record. A thrown fetch never poisons
 * the cache with null; it either serves a still-valid stale record or reports
 * `failed` for the caller to skip on.
 */
export async function getReleaseSchedule(
  tmdbId: number,
  mediaType: 'movie' | 'show',
  opts: GetReleaseScheduleOptions = {}
): Promise<ReleaseScheduleResult> {
  const region =
    opts.region ?? getSettings().overlays?.watchProviderRegion ?? 'US';
  const key = cacheKeyFor(tmdbId, mediaType, region);

  const cache = cacheManager.getCache('tmdb-releases').data;
  const record = cache.get<ReleaseScheduleRecord>(key);
  if (record && Date.now() - record.fetchedAt < record.softTtlSeconds * 1000) {
    return toResult(record, 'cache');
  }

  // Missing or soft-stale: fetch, de-duplicating concurrent callers.
  const existing = inflight.get(key);
  if (existing) return existing;

  const pending = fetchAndStore(
    tmdbId,
    mediaType,
    region,
    key,
    opts.year
  ).finally(() => {
    if (inflight.get(key) === pending) {
      inflight.delete(key);
    }
  });
  inflight.set(key, pending);
  return pending;
}

/** Test-only: clear the in-flight de-dup map between cases. */
export function __clearInflightForTests(): void {
  inflight.clear();
}

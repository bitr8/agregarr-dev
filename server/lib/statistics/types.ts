import type { StatisticsProviderType } from '@server/lib/settings';

/**
 * Watch-statistics provider abstraction.
 *
 * Agregarr historically read all playback statistics from Tautulli. Tracearr
 * is an alternative backend; the rest of the app (statistics collections,
 * dashboard, per-media watch data) talks to this interface and never to a
 * concrete client. Field names stay snake_case where the frontend already
 * consumes the Tautulli-shaped payloads.
 */

export type StatisticsMediaType = 'movie' | 'tv';
export type StatisticsStatType = 'plays' | 'duration';
export type StatisticsCollectionType = 'most_popular' | 'most_watched';

/** One row of a "top content" list */
export interface StatisticsContentRow {
  rating_key: string;
  title: string;
  /** 'movie' | 'show' | 'episode' (Tautulli reports TV shows as 'episode') */
  media_type: string;
  total_plays: number;
  /** Seconds */
  total_duration?: number;
  /** Distinct viewers; undefined when the provider cannot supply it */
  users_watched?: number;
  year?: number;
  tmdb_id?: number;
  tvdb_id?: number;
  /** Unix seconds */
  last_played?: number;
}

export interface MediaWatchDataQuery {
  ratingKey: string;
  mediaType: StatisticsMediaType;
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
}

export interface MediaWatchData {
  playCount: number;
  playCount7Days: number;
  playCount30Days: number;
  /** Plex account ids of everyone who played the item */
  plexUserIds: number[];
}

export interface WatchTimeStats {
  /** 0 = all time */
  query_days: number;
  /** Seconds */
  total_time: number;
  total_plays: number;
}

export interface WatchUserStats {
  friendly_name: string;
  /** Plex account id */
  user_id: number;
  username?: string;
  user_thumb?: string;
  total_plays: number;
  /** Seconds */
  total_time: number;
}

export interface CollectionStatistics {
  rating_key: string;
  title: string;
  media_type: string;
  section_id: number;
  section_name: string;
  item_count: number;
  total_plays: number;
  /** Seconds */
  total_duration: number;
  last_played?: number;
  play_count?: number;
  watch_time_stats: WatchTimeStats[];
  user_stats: WatchUserStats[];
}

export interface StatisticsProviderInfo {
  provider: StatisticsProviderType;
  version?: string;
}

export interface StatisticsProvider {
  readonly type: StatisticsProviderType;
  readonly displayName: string;

  /** Connection check; rejects when the backend is unreachable */
  getInfo(): Promise<StatisticsProviderInfo>;

  /**
   * Top movies or shows over the last `timeRangeDays`.
   * `most_popular` ranks by distinct viewers, `most_watched` by plays or
   * watch time (`statType`).
   */
  getContent(
    mediaType: StatisticsMediaType,
    timeRangeDays: number,
    statType: StatisticsStatType,
    collectionType: StatisticsCollectionType,
    limit: number
  ): Promise<StatisticsContentRow[]>;

  /** Play counts and viewers for a single Plex item */
  getMediaWatchData(query: MediaWatchDataQuery): Promise<MediaWatchData>;

  /**
   * Statistics for the given Plex collections over `queryDays`, sorted by
   * `statType` and truncated to `limit`. Never rejects; failures yield [].
   */
  getTopCollections(
    limit: number,
    statType: StatisticsStatType,
    queryDays: number,
    collectionRatingKeys: string[]
  ): Promise<CollectionStatistics[]>;

  /**
   * Detailed statistics for one Plex collection.
   * @param queryDays Comma-separated day windows, 0 = all time (e.g. '1,7,30,0')
   */
  getCollectionStats(
    ratingKey: string,
    queryDays: string
  ): Promise<CollectionStatistics>;
}

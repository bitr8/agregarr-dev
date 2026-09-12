import type PlexAPI from '@server/api/plexapi';
import type { TracearrHistoryRow } from '@server/api/tracearr';
import TracearrAPI, { groupHistoryRowsByItem } from '@server/api/tracearr';
import cacheManager from '@server/lib/cache';
import type { TracearrSettings } from '@server/lib/settings';
import type {
  CollectionStatistics,
  MediaWatchData,
  MediaWatchDataQuery,
  StatisticsCollectionType,
  StatisticsContentRow,
  StatisticsMediaType,
  StatisticsProvider,
  StatisticsProviderInfo,
  StatisticsStatType,
  WatchTimeStats,
  WatchUserStats,
} from '@server/lib/statistics/types';
import logger from '@server/logger';

const LABEL = 'Tracearr Statistics';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Plex's collection children endpoint returns full metadata for every member
 * (~1s per large collection), so membership is cached briefly. Statistics
 * windows are days long; a few minutes of staleness is invisible.
 */
const COLLECTION_CACHE_TTL_SECONDS = 300;

interface CachedCollection {
  metadata: Awaited<ReturnType<PlexAPI['getCollectionMetadataSafe']>>;
  itemRatingKeys: string[];
}

async function getCollectionMembership(
  plexClient: PlexAPI,
  ratingKey: string
): Promise<CachedCollection> {
  const cache = cacheManager.getCache('tracearr').data;
  const key = `plex-collection:${ratingKey}`;
  const cached = cache.get<CachedCollection>(key);
  if (cached) {
    return cached;
  }

  const [metadata, itemRatingKeys] = await Promise.all([
    plexClient.getCollectionMetadataSafe(ratingKey),
    plexClient.getCollectionItems(ratingKey),
  ]);
  const result = { metadata, itemRatingKeys };
  if (metadata || itemRatingKeys.length > 0) {
    cache.set(key, result, COLLECTION_CACHE_TTL_SECONDS);
  }
  return result;
}

function rowsWithinDays(
  rows: TracearrHistoryRow[],
  days: number,
  now = Date.now()
): TracearrHistoryRow[] {
  if (days <= 0) return rows;
  const cutoff = now - days * DAY_MS;
  return rows.filter((row) => new Date(row.started_at).getTime() >= cutoff);
}

function sumDurationSeconds(rows: TracearrHistoryRow[]): number {
  return Math.round(
    rows.reduce((sum, row) => sum + (row.duration_ms ?? 0), 0) / 1000
  );
}

function buildWatchTimeStats(
  rows: TracearrHistoryRow[],
  windows: number[]
): WatchTimeStats[] {
  const now = Date.now();
  return windows.map((days) => {
    const subset = rowsWithinDays(rows, days, now);
    return {
      query_days: days,
      total_plays: subset.length,
      total_time: sumDurationSeconds(subset),
    };
  });
}

function buildUserStats(
  rows: TracearrHistoryRow[],
  plexUserIds: Map<string, number>
): WatchUserStats[] {
  const byUser = new Map<string, WatchUserStats>();
  for (const row of rows) {
    const serverUserId = row.user.server_user_id;
    const existing = byUser.get(serverUserId);
    const seconds = Math.round((row.duration_ms ?? 0) / 1000);
    if (existing) {
      existing.total_plays += 1;
      existing.total_time += seconds;
    } else {
      const name = row.user.username ?? serverUserId;
      byUser.set(serverUserId, {
        friendly_name: name,
        username: name,
        user_id: plexUserIds.get(serverUserId) ?? 0,
        user_thumb: row.user.avatar_url ?? undefined,
        total_plays: 1,
        total_time: seconds,
      });
    }
  }
  return Array.from(byUser.values()).sort(
    (a, b) => b.total_plays - a.total_plays
  );
}

/**
 * Tracearr-backed statistics provider.
 *
 * Tracearr only exposes a play log, so everything here is derived: top
 * content is a group-by over history rows, and collection statistics join
 * that history with the collection's members read from Plex.
 */
export class TracearrStatisticsProvider implements StatisticsProvider {
  public readonly type = 'tracearr' as const;
  public readonly displayName = 'Tracearr';
  private api: TracearrAPI;
  private getPlexClient: () => Promise<PlexAPI>;

  constructor(
    settings: TracearrSettings,
    getPlexClient: () => Promise<PlexAPI>
  ) {
    this.api = new TracearrAPI(settings);
    this.getPlexClient = getPlexClient;
  }

  public async getInfo(): Promise<StatisticsProviderInfo> {
    const health = await this.api.getHealth();
    if (!health || health.status !== 'ok') {
      throw new Error('Unable to connect to Tracearr');
    }
    return { provider: this.type, version: health.version };
  }

  public async getContent(
    mediaType: StatisticsMediaType,
    timeRangeDays: number,
    statType: StatisticsStatType,
    collectionType: StatisticsCollectionType,
    limit: number
  ): Promise<StatisticsContentRow[]> {
    const items = await this.api.getContent(
      mediaType,
      timeRangeDays,
      statType,
      collectionType,
      limit
    );

    return items.map((item) => ({
      rating_key: item.ratingKey,
      title: item.title,
      media_type: item.mediaType,
      total_plays: item.totalPlays,
      total_duration: item.totalDuration,
      users_watched: item.serverUserIds.size,
      year: item.year,
      tmdb_id: item.tmdbId,
      tvdb_id: item.tvdbId,
      last_played: item.lastPlayed,
    }));
  }

  public async getMediaWatchData(
    query: MediaWatchDataQuery
  ): Promise<MediaWatchData> {
    let rows: TracearrHistoryRow[] = [];

    if (query.mediaType === 'movie') {
      rows = await this.api.getHistory({
        mediaType: 'movie',
        ratingKey: query.ratingKey,
      });
    } else {
      // Episode plays cannot be filtered by show rating key directly; resolve
      // the show's canonical Tracearr media record via a provider id, pull its
      // plays, then keep the ones that belong to this Plex show item.
      const ref = query.tmdbId
        ? `show:tmdb:${query.tmdbId}`
        : query.tvdbId
        ? `show:tvdb:${query.tvdbId}`
        : query.imdbId
        ? `show:imdb:${query.imdbId}`
        : null;

      const media = ref ? await this.api.getMedia(ref) : null;
      if (!media) {
        logger.debug('Show not known to Tracearr; no watch data', {
          label: LABEL,
          ratingKey: query.ratingKey,
          ref,
        });
      } else {
        const showRows = await this.api.getHistory({
          mediaType: 'episode',
          mediaId: media.id,
        });
        rows = showRows.filter(
          (row) => row.grandparent_rating_key === query.ratingKey
        );
      }
    }

    const plexUserIds = rows.length ? await this.api.getPlexUserIdMap() : null;
    const users = new Set<number>();
    for (const row of rows) {
      const plexId = plexUserIds?.get(row.user.server_user_id);
      if (plexId !== undefined) users.add(plexId);
    }

    const now = Date.now();
    return {
      playCount: rows.length,
      playCount7Days: rowsWithinDays(rows, 7, now).length,
      playCount30Days: rowsWithinDays(rows, 30, now).length,
      plexUserIds: Array.from(users),
    };
  }

  /**
   * Resolve a collection's members and metadata from Plex and roll up the
   * matching history rows.
   */
  private async buildCollectionStatistics(
    ratingKey: string,
    grouped: Map<string, TracearrHistoryRow[]>,
    windows: number[],
    plexClient: PlexAPI,
    plexUserIds: Map<string, number>
  ): Promise<CollectionStatistics | null> {
    const { metadata, itemRatingKeys } = await getCollectionMembership(
      plexClient,
      ratingKey
    );

    if (!metadata && itemRatingKeys.length === 0) {
      return null;
    }

    // `grouped` only spans the days the caller fetched, so `rows` is already
    // bounded to the widest requested window.
    const rows = itemRatingKeys.flatMap((key) => grouped.get(key) ?? []);
    const watchTimeStats = buildWatchTimeStats(rows, windows);

    const subtype = metadata?.subtype as string | undefined;
    const mediaType =
      subtype === 'movie' || subtype === 'show'
        ? subtype
        : rows[0]?.media_type === 'movie'
        ? 'movie'
        : rows.length
        ? 'show'
        : 'collection';

    const lastPlayed = rows.reduce<number | undefined>((latest, row) => {
      const at = Math.floor(new Date(row.started_at).getTime() / 1000);
      return latest === undefined || at > latest ? at : latest;
    }, undefined);

    return {
      rating_key: ratingKey,
      title: metadata?.title ?? `Collection ${ratingKey}`,
      media_type: mediaType,
      section_id: Number(metadata?.librarySectionID ?? 0),
      section_name: String(metadata?.librarySectionTitle ?? ''),
      item_count: metadata?.childCount ?? itemRatingKeys.length,
      total_plays: rows.length,
      total_duration: sumDurationSeconds(rows),
      last_played: lastPlayed,
      play_count: rows.length,
      watch_time_stats: watchTimeStats,
      user_stats: buildUserStats(rows, plexUserIds),
    };
  }

  public async getTopCollections(
    limit: number,
    statType: StatisticsStatType,
    queryDays: number,
    collectionRatingKeys: string[]
  ): Promise<CollectionStatistics[]> {
    if (collectionRatingKeys.length === 0) {
      return [];
    }

    try {
      const [rows, plexClient, plexUserIds] = await Promise.all([
        this.api.getHistoryForDays(queryDays),
        this.getPlexClient(),
        this.api.getPlexUserIdMap(),
      ]);
      const grouped = groupHistoryRowsByItem(rows);

      // Collections resolve in parallel; each is at most two Plex calls
      // (cached after the first load), so this stays a handful of requests.
      const results = await Promise.all(
        collectionRatingKeys.map(async (ratingKey) => {
          try {
            return await this.buildCollectionStatistics(
              ratingKey,
              grouped,
              [queryDays],
              plexClient,
              plexUserIds
            );
          } catch (error) {
            logger.warn(`Failed to build stats for collection ${ratingKey}`, {
              label: LABEL,
              ratingKey,
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          }
        })
      );
      const stats = results.filter(
        (collection): collection is CollectionStatistics =>
          !!collection && collection.total_plays > 0
      );

      stats.sort((a, b) =>
        statType === 'duration'
          ? b.total_duration - a.total_duration
          : b.total_plays - a.total_plays
      );

      return stats.slice(0, limit);
    } catch (error) {
      logger.error('Failed to derive collection statistics from Tracearr', {
        label: LABEL,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  public async getCollectionStats(
    ratingKey: string,
    queryDays: string
  ): Promise<CollectionStatistics> {
    const windows = queryDays
      .split(',')
      .map((d) => parseInt(d.trim(), 10))
      .filter((d) => Number.isFinite(d) && d >= 0);
    if (windows.length === 0) {
      windows.push(0);
    }
    // 0 (all time) needs the full log; otherwise the widest window suffices
    const span = windows.includes(0) ? 0 : Math.max(...windows);

    const [rows, plexClient, plexUserIds] = await Promise.all([
      this.api.getHistoryForDays(span),
      this.getPlexClient(),
      this.api.getPlexUserIdMap(),
    ]);

    const collection = await this.buildCollectionStatistics(
      ratingKey,
      groupHistoryRowsByItem(rows),
      windows,
      plexClient,
      plexUserIds
    );

    if (!collection) {
      throw new Error(`Collection with rating key ${ratingKey} not found`);
    }

    return collection;
  }
}

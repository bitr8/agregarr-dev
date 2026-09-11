import TautulliAPI from '@server/api/tautulli';
import type { TautulliSettings } from '@server/lib/settings';
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
} from '@server/lib/statistics/types';

/**
 * Tautulli-backed statistics provider. Thin adapter over the existing
 * TautulliAPI client; all heavy lifting (home stats, item stats) happens in
 * Tautulli itself.
 */
export class TautulliStatisticsProvider implements StatisticsProvider {
  public readonly type = 'tautulli' as const;
  public readonly displayName = 'Tautulli';
  private api: TautulliAPI;

  constructor(settings: TautulliSettings) {
    this.api = new TautulliAPI(settings);
  }

  public async getInfo(): Promise<StatisticsProviderInfo> {
    const info = await this.api.getInfo();
    if (!info || !info.tautulli_version) {
      throw new Error('Unable to connect to Tautulli');
    }
    return { provider: this.type, version: info.tautulli_version };
  }

  public async getContent(
    mediaType: StatisticsMediaType,
    timeRangeDays: number,
    statType: StatisticsStatType,
    collectionType: StatisticsCollectionType,
    limit: number
  ): Promise<StatisticsContentRow[]> {
    const rows = await this.api.getContent(
      mediaType,
      timeRangeDays,
      statType,
      collectionType,
      limit
    );

    return rows.map((row) => {
      // `users_watched` is a string for popular_* stats and empty for top_*
      const usersWatched = parseInt(String(row.users_watched ?? ''), 10);
      return {
        rating_key: String(row.rating_key),
        title: row.title,
        media_type: row.media_type,
        total_plays: row.total_plays ?? row.plays ?? 0,
        users_watched: Number.isFinite(usersWatched) ? usersWatched : undefined,
      };
    });
  }

  public async getMediaWatchData(
    query: MediaWatchDataQuery
  ): Promise<MediaWatchData> {
    const [watchStats, watchUsers] = await Promise.all([
      this.api.getMediaWatchStats(query.ratingKey),
      this.api.getMediaWatchUsers(query.ratingKey),
    ]);

    return {
      playCount: watchStats.find((i) => i.query_days == 0)?.total_plays ?? 0,
      playCount7Days:
        watchStats.find((i) => i.query_days == 7)?.total_plays ?? 0,
      playCount30Days:
        watchStats.find((i) => i.query_days == 30)?.total_plays ?? 0,
      plexUserIds: watchUsers.map((u) => u.user_id),
    };
  }

  public getTopCollections(
    limit: number,
    statType: StatisticsStatType,
    queryDays: number,
    collectionRatingKeys: string[]
  ): Promise<CollectionStatistics[]> {
    return this.api.getTopCollections(
      limit,
      statType,
      queryDays,
      collectionRatingKeys
    );
  }

  public getCollectionStats(
    ratingKey: string,
    queryDays: string
  ): Promise<CollectionStatistics> {
    return this.api.getCollectionStats(ratingKey, queryDays);
  }
}

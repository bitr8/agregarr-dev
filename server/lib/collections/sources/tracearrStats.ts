import type PlexAPI from '@server/api/plexapi';
import { isPlexNotFoundError } from '@server/api/plexMetadataClassify';
import TheMovieDb from '@server/api/themoviedb';
import TracearrAPI, {
  clampTracearrDays,
  TracearrHttpError,
  type TracearrSort,
  type TracearrTopMediaRow,
} from '@server/api/tracearr';
import {
  extractTvdbIdFromGuids,
  findPlexItemsByTmdbIds,
  getCollectionMediaType,
  type LibraryItemsCache,
} from '@server/lib/collections/core/CollectionUtilities';
import type {
  CollectionSyncOptions,
  PlexLookupResult,
  TautulliSourceData,
} from '@server/lib/collections/core/types';
import { CollectionSyncErrorType } from '@server/lib/collections/core/types';
import { TautulliCollectionSync } from '@server/lib/collections/sources/tautulli';
import type { CollectionConfig } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { mapWithConcurrency } from '@server/utils/mapWithConcurrency';

const LABEL = 'Tracearr Collections';
const FALLBACK_CAP = 25;
const FALLBACK_CONCURRENCY = 4;

type MappedResult = Awaited<
  ReturnType<TautulliCollectionSync['mapSourceDataToItems']>
>;

const normaliseTitle = (title: string): string => title.trim().toLowerCase();

export class TracearrStatsCollectionSync extends TautulliCollectionSync {
  protected async validateConfiguration(): Promise<void> {
    const { tracearr } = getSettings();
    if (!tracearr?.apiKey || !tracearr.hostname) {
      throw this.createSyncError(
        CollectionSyncErrorType.CONFIGURATION_ERROR,
        'Tracearr not configured - missing API key or hostname'
      );
    }
  }

  protected generateCacheKey(config: CollectionConfig): string {
    const { tracearr } = getSettings();
    return [
      'tracearr',
      tracearr?.hostname ?? '',
      tracearr?.port ?? '',
      tracearr?.serverId ?? '',
      this.getStatTypeFromSubtype(config),
      super.generateCacheKey(config),
    ].join(':');
  }

  public async fetchSourceData(
    config: CollectionConfig,
    options?: CollectionSyncOptions & { useCache?: boolean },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature parity with the base class
    libraryCache?: LibraryItemsCache
  ): Promise<TautulliSourceData[]> {
    const { tracearr } = getSettings();
    const mediaType = getCollectionMediaType(config);
    const days = clampTracearrDays(this.getTimeRangeDays(config));
    const statType = this.getStatTypeFromSubtype(config);
    const popular =
      this.getCollectionTypeFromSubtype(config) === 'most_popular';
    const minimumPlays = config.minimumPlays ?? 3;

    const sort: TracearrSort = popular
      ? 'viewers'
      : statType === 'duration'
      ? 'watch_time'
      : 'plays';

    const { rows, truncated } = await new TracearrAPI(tracearr).getTopMedia({
      mediaType: mediaType === 'tv' ? 'show' : 'movie',
      days,
      sort,
      minViewers: popular ? minimumPlays : undefined,
      bypassCache: options?.useCache === false,
    });

    const ordered = popular
      ? [...rows].sort(
          (a, b) =>
            b.unique_users - a.unique_users ||
            (statType === 'duration'
              ? b.watch_time_ms - a.watch_time_ms
              : b.plays - a.plays) ||
            (b.last_watched_day ?? '').localeCompare(a.last_watched_day ?? '')
        )
      : rows;

    logger.info('Tracearr top-media received', {
      label: LABEL,
      configName: config.name,
      mediaType,
      days,
      sort,
      rows: ordered.length,
      truncated,
    });

    return ordered.map((row) => this.toSourceData(row));
  }

  public async mapSourceDataToItems(
    sourceData: TautulliSourceData[],
    config: CollectionConfig,
    plexClient?: PlexAPI,
    libraryCache?: LibraryItemsCache
  ): Promise<MappedResult> {
    const isMostWatched = config.subtype?.startsWith('most_watched') ?? false;
    const minimumPlays = config.minimumPlays ?? 3;
    const mediaType = getCollectionMediaType(config);

    const rows = sourceData.filter((row) => {
      const rowType = row.media_type === 'movie' ? 'movie' : 'tv';
      const viewers = Number(row.users_watched) || 0;
      return (
        rowType === mediaType && (isMostWatched || viewers >= minimumPlays)
      );
    });

    if (!plexClient) {
      logger.warn('No Plex client provided, cannot resolve Tracearr items', {
        label: LABEL,
        configName: config.name,
      });
      return {
        items: [],
        missingItems: [],
        stats: this.createFilteringStats(sourceData.length, 0, {
          'no plex client': sourceData.length,
        }),
      };
    }

    const tmdbByRow = new Map<TautulliSourceData, number>();
    for (const row of rows) {
      if (row.tmdb_id) tmdbByRow.set(row, row.tmdb_id);
    }
    await this.resolveTmdbIds(
      rows.filter((row) => !row.tmdb_id),
      mediaType,
      tmdbByRow
    );

    const lookups = [...new Set(tmdbByRow.values())].map((tmdbId) => ({
      tmdbId,
      mediaType,
      title: '',
    }));
    const plexLookup =
      lookups.length > 0
        ? await findPlexItemsByTmdbIds(
            plexClient,
            lookups,
            config.libraryId,
            libraryCache,
            false
          )
        : new Map<string, PlexLookupResult>();

    const matched = new Map<TautulliSourceData, PlexLookupResult>();
    const stillUnmatched: TautulliSourceData[] = [];
    for (const row of rows) {
      const tmdbId = tmdbByRow.get(row);
      const hit = tmdbId ? plexLookup.get(`${tmdbId}-${mediaType}`) : undefined;
      if (hit) {
        matched.set(row, hit);
      } else if (row.tracearr_media_id) {
        stillUnmatched.push(row);
      }
    }
    await this.resolveViaAvailability(
      stillUnmatched,
      config,
      plexClient,
      matched
    );

    const items: MappedResult['items'] = [];
    rows.forEach((row, index) => {
      const hit = matched.get(row);
      if (!hit) return;
      items.push({
        ratingKey: hit.ratingKey,
        title: hit.title,
        totalPlays: row.total_plays || 0,
        type: mediaType,
        tmdbId: tmdbByRow.get(row),
        tvdbId: hit.tvdbId ?? row.tvdb_id,
        year: row.year,
        addedAt: hit.addedAt,
        releaseDate: hit.releaseDate,
        metadata: { libraryKey: hit.libraryKey, originalPosition: index + 1 },
      });
    });

    if (items.length < rows.length) {
      logger.info('Tracearr titles not found in the target Plex library', {
        label: LABEL,
        configName: config.name,
        count: rows.length - items.length,
        titles: rows
          .filter((row) => !matched.has(row))
          .slice(0, 10)
          .map((row) => row.title),
      });
    }

    return {
      items,
      missingItems: [],
      stats: this.createFilteringStats(sourceData.length, items.length, {
        'insufficient plays': sourceData.length - rows.length,
        'not in plex': rows.length - items.length,
      }),
    };
  }

  private toSourceData(row: TracearrTopMediaRow): TautulliSourceData {
    return {
      title: row.title,
      media_type: row.media_type,
      year: row.year ?? undefined,
      tmdb_id: row.tmdb_id ?? undefined,
      tvdb_id: row.tvdb_id ?? undefined,
      imdb_id: row.imdb_id ?? undefined,
      tracearr_media_id: row.media_id,
      total_plays: row.plays,
      plays: row.plays,
      users_watched: row.unique_users,
      duration: Math.round(row.watch_time_ms / 1000),
      last_played: undefined,
    };
  }

  private async resolveTmdbIds(
    rows: TautulliSourceData[],
    mediaType: 'movie' | 'tv',
    out: Map<TautulliSourceData, number>
  ): Promise<void> {
    if (rows.length === 0) return;
    const tmdb = new TheMovieDb();
    await mapWithConcurrency(
      rows.slice(0, FALLBACK_CAP),
      FALLBACK_CONCURRENCY,
      async (row) => {
        try {
          const found =
            mediaType === 'tv' && row.tvdb_id
              ? await tmdb.getByExternalId({
                  externalId: row.tvdb_id,
                  type: 'tvdb',
                })
              : row.imdb_id
              ? await tmdb.getByExternalId({
                  externalId: row.imdb_id,
                  type: 'imdb',
                })
              : undefined;
          const id = (
            mediaType === 'tv' ? found?.tv_results : found?.movie_results
          )?.[0]?.id;
          if (id) out.set(row, id);
        } catch (error) {
          logger.debug(`TMDB lookup failed for ${row.title}`, {
            label: LABEL,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );
  }

  private async resolveViaAvailability(
    rows: TautulliSourceData[],
    config: CollectionConfig,
    plexClient: PlexAPI,
    out: Map<TautulliSourceData, PlexLookupResult>
  ): Promise<void> {
    if (rows.length === 0) return;
    const { tracearr } = getSettings();
    const api = new TracearrAPI(tracearr);

    await mapWithConcurrency(
      rows.slice(0, FALLBACK_CAP),
      FALLBACK_CONCURRENCY,
      async (row) => {
        let media;
        try {
          media = await api.getMedia(row.tracearr_media_id as string);
        } catch (error) {
          if (error instanceof TracearrHttpError && error.status === 404) {
            return;
          }
          throw error;
        }

        for (const entry of media.availability ?? []) {
          if (
            entry.server_type !== 'plex' ||
            !entry.rating_key ||
            entry.removed_at ||
            (tracearr.serverId && entry.server_id !== tracearr.serverId)
          ) {
            continue;
          }
          let meta;
          try {
            meta = await plexClient.getMetadata(entry.rating_key);
          } catch (error) {
            if (error instanceof Error && isPlexNotFoundError(error.message)) {
              continue;
            }
            throw error;
          }
          const plexYear = (meta as { year?: number }).year;
          const sameLibrary =
            meta.librarySectionID === undefined ||
            String(meta.librarySectionID) === String(config.libraryId);
          const sameYear =
            plexYear === undefined ||
            row.year === undefined ||
            plexYear === row.year;
          if (
            sameLibrary &&
            sameYear &&
            normaliseTitle(meta.title) === normaliseTitle(row.title ?? '')
          ) {
            out.set(row, {
              ratingKey: meta.ratingKey,
              title: meta.title,
              libraryKey: config.libraryId,
              addedAt: meta.addedAt,
              tvdbId: extractTvdbIdFromGuids(meta.Guid),
            });
            return;
          }
        }
      }
    );
  }
}

export default TracearrStatsCollectionSync;

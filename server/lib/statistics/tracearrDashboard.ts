import PlexAPI from '@server/api/plexapi';
import TracearrAPI, {
  clampTracearrDays,
  type TracearrTopMediaRow,
} from '@server/api/tracearr';
import {
  extractTmdbIdFromGuids,
  extractTvdbIdFromGuids,
  getAdminUser,
} from '@server/lib/collections/core/CollectionUtilities';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { mapWithConcurrency } from '@server/utils/mapWithConcurrency';

const MEMBERS_TTL_MS = 5 * 60 * 1000;
const PLEX_CONCURRENCY = 4;

export interface TracearrCollectionStat {
  rating_key: string;
  title: string;
  media_type: string;
  section_id: number;
  section_name: string;
  item_count: number;
  total_plays: number;
  total_duration: number;
  last_played?: number;
  watch_time_stats: never[];
  user_stats: never[];
}

interface CollectionMembers {
  title: string;
  sectionId: number;
  sectionName: string;
  refs: string[];
}

const membersCache = new Map<
  string,
  { expires: number; promise: Promise<CollectionMembers | null> }
>();

const rowRefs = (row: TracearrTopMediaRow): string[] => {
  const refs: string[] = [];
  if (row.tmdb_id) refs.push(`${row.media_type}:tmdb:${row.tmdb_id}`);
  if (row.media_type === 'show' && row.tvdb_id) {
    refs.push(`show:tvdb:${row.tvdb_id}`);
  }
  return refs;
};

async function getPlexClient(): Promise<PlexAPI> {
  const admin = await getAdminUser();
  if (!admin?.plexToken) {
    throw new Error('No local admin Plex token found');
  }
  return new PlexAPI({
    plexToken: admin.plexToken,
    plexSettings: getSettings().plex,
  });
}

function loadMembers(
  plex: PlexAPI,
  ratingKey: string
): Promise<CollectionMembers | null> {
  const now = Date.now();
  const hit = membersCache.get(ratingKey);
  if (hit && hit.expires > now) return hit.promise;

  const promise = (async (): Promise<CollectionMembers | null> => {
    const meta = await plex.getCollectionMetadataSafe(ratingKey);
    if (!meta) return null;
    const children = await plex.getCollectionItemsWithMetadata(ratingKey);
    const refs: string[] = [];
    for (const child of children) {
      if (child.type !== 'movie' && child.type !== 'show') continue;
      const tmdbId = extractTmdbIdFromGuids(child.Guid);
      const tvdbId = extractTvdbIdFromGuids(child.Guid);
      if (tmdbId) refs.push(`${child.type}:tmdb:${tmdbId}`);
      else if (child.type === 'show' && tvdbId) {
        refs.push(`show:tvdb:${tvdbId}`);
      } else refs.push('');
    }
    return {
      title: meta.title,
      sectionId: Number(meta.librarySectionID) || 0,
      sectionName: String(meta.librarySectionTitle ?? ''),
      refs,
    };
  })();

  membersCache.set(ratingKey, { expires: now + MEMBERS_TTL_MS, promise });
  promise.catch(() => {
    if (membersCache.get(ratingKey)?.promise === promise) {
      membersCache.delete(ratingKey);
    }
  });
  return promise;
}

async function fetchAllRows(days: number): Promise<{
  movies: TracearrTopMediaRow[];
  shows: TracearrTopMediaRow[];
}> {
  const api = new TracearrAPI(getSettings().tracearr);
  const [movies, shows] = await Promise.all(
    (['movie', 'show'] as const).map((mediaType) =>
      api.getTopMedia({ mediaType, days, sort: 'plays' })
    )
  );
  return { movies: movies.rows, shows: shows.rows };
}

export async function getTracearrWeeklyRows(): Promise<{
  movies: TracearrTopMediaRow[];
  shows: TracearrTopMediaRow[];
}> {
  const { movies, shows } = await fetchAllRows(7);
  return { movies: movies.slice(0, 10), shows: shows.slice(0, 10) };
}

export async function getTracearrDashboardInputs(
  collectionRatingKeys: string[]
): Promise<
  [
    TracearrCollectionStat[],
    { total_plays: number }[],
    { total_plays: number }[]
  ]
> {
  const [collections, weekly] = await Promise.all([
    getTracearrCollectionStats({
      limit: 50,
      statType: 'plays',
      days: 7,
      collectionRatingKeys,
    }),
    getTracearrWeeklyRows(),
  ]);
  const plays = (rows: TracearrTopMediaRow[]) =>
    rows.map((row) => ({ total_plays: row.plays }));
  return [collections, plays(weekly.movies), plays(weekly.shows)];
}

export async function getTracearrCollectionStats(options: {
  limit: number;
  statType: 'plays' | 'duration';
  days: number;
  collectionRatingKeys: string[];
}): Promise<TracearrCollectionStat[]> {
  if (options.collectionRatingKeys.length === 0) return [];

  const days = clampTracearrDays(options.days);
  const { movies, shows } = await fetchAllRows(days);
  const totals = new Map<string, { plays: number; watchTimeMs: number }>();
  for (const row of [...movies, ...shows]) {
    for (const ref of rowRefs(row)) {
      totals.set(ref, { plays: row.plays, watchTimeMs: row.watch_time_ms });
    }
  }

  const plex = await getPlexClient();
  const stats: TracearrCollectionStat[] = [];
  await mapWithConcurrency(
    options.collectionRatingKeys,
    PLEX_CONCURRENCY,
    async (ratingKey) => {
      let members: CollectionMembers | null;
      try {
        members = await loadMembers(plex, ratingKey);
      } catch (error) {
        logger.warn(`Failed to read members of collection ${ratingKey}`, {
          label: 'Tracearr Dashboard',
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (!members) return;
      let plays = 0;
      let watchTimeMs = 0;
      for (const ref of members.refs) {
        const total = ref ? totals.get(ref) : undefined;
        if (total) {
          plays += total.plays;
          watchTimeMs += total.watchTimeMs;
        }
      }
      if (plays === 0) return;
      stats.push({
        rating_key: ratingKey,
        title: members.title,
        media_type: 'collection',
        section_id: members.sectionId,
        section_name: members.sectionName,
        item_count: members.refs.length,
        total_plays: plays,
        total_duration: Math.round(watchTimeMs / 1000),
        watch_time_stats: [],
        user_stats: [],
      });
    }
  );

  return stats
    .sort((a, b) =>
      options.statType === 'plays'
        ? b.total_plays - a.total_plays
        : b.total_duration - a.total_duration
    )
    .slice(0, options.limit);
}

import type {
  TmdbSeasonWithEpisodes,
  TmdbTvEpisodeResult,
} from '@server/api/themoviedb/interfaces';
import type { OverlayRenderContext } from './OverlayTemplateRenderer';

export const TMDB_RATING_CONTEXT_FIELDS = [
  'tmdbRating',
  'tmdbVoteCount',
] as const;

export type TmdbRatingContext = Pick<
  OverlayRenderContext,
  (typeof TMDB_RATING_CONTEXT_FIELDS)[number]
>;

/** TMDB fields are opt-in so unrelated templates do not add API work. */
export function usesTmdbRatingFields(
  requiredContextFields?: ReadonlySet<string>
): boolean {
  return (
    !requiredContextFields ||
    TMDB_RATING_CONTEXT_FIELDS.some((field) => requiredContextFields.has(field))
  );
}

/** Extract a numeric TMDB id from a Plex GUID list. */
export function extractTmdbId(
  guids?: readonly { id?: string }[]
): number | undefined {
  const tmdbGuid = guids?.find((guid) => guid.id?.includes('tmdb://'));
  const match = tmdbGuid?.id?.match(/tmdb:\/\/(\d+)/);
  if (!match) return undefined;

  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * Normalize TMDB's rating fields. A zero vote average is TMDB's missing-value
 * sentinel, not a real zero-star rating. Keeping an explicit undefined rating
 * is important for child artwork because it blocks a parent-show fallback.
 */
export function toTmdbRatingContext(
  voteAverage?: number,
  voteCount?: number
): TmdbRatingContext {
  const normalizedVoteCount =
    typeof voteCount === 'number' && Number.isFinite(voteCount)
      ? Math.max(0, Math.floor(voteCount))
      : undefined;
  const hasUsableRating =
    typeof voteAverage === 'number' &&
    Number.isFinite(voteAverage) &&
    voteAverage > 0 &&
    (normalizedVoteCount === undefined || normalizedVoteCount > 0);

  return {
    tmdbRating: hasUsableRating ? voteAverage : undefined,
    tmdbVoteCount: normalizedVoteCount,
  };
}

/** Return the season's own TMDB score, never a series fallback. */
export function getTmdbSeasonRatingContext(
  season: TmdbSeasonWithEpisodes
): TmdbRatingContext {
  return toTmdbRatingContext(season.vote_average, season.vote_count);
}

/** Return the exact episode score from a season-details response. */
export function getTmdbEpisodeRatingContext(
  season: TmdbSeasonWithEpisodes,
  episodeNumber: number
): TmdbRatingContext {
  const episode: TmdbTvEpisodeResult | undefined = season.episodes?.find(
    (candidate) => candidate.episode_number === episodeNumber
  );

  return episode
    ? toTmdbRatingContext(episode.vote_average, episode.vote_count)
    : toTmdbRatingContext();
}

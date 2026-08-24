import type { PlexLibraryItem } from '@server/api/plexapi';

type SeasonRatingEpisode = Pick<
  PlexLibraryItem,
  'ratingKey' | 'type' | 'parentRatingKey' | 'Guid'
>;

/**
 * IMDb does not expose a separate title/rating for a season. Derive the value
 * displayed on a season poster from the episode titles IMDb does rate.
 *
 * Missing episode ratings are ignored. A season with no rated episodes is not
 * returned, allowing the renderer to leave its poster without an IMDb badge.
 */
export function calculateSeasonImdbRatings(
  episodes: readonly SeasonRatingEpisode[],
  imdbRatings: ReadonlyMap<string, number | null> | undefined
): Map<string, number> {
  const totals = new Map<
    string,
    { sum: number; count: number; episodeKeys: Set<string> }
  >();

  if (!imdbRatings) return new Map();

  for (const episode of episodes) {
    if (episode.type !== 'episode' || !episode.parentRatingKey) continue;

    const imdbGuid = episode.Guid?.find((guid) =>
      guid.id?.startsWith('imdb://')
    );
    const imdbId = imdbGuid?.id.slice('imdb://'.length);
    if (!imdbId) continue;

    const rating = imdbRatings.get(imdbId);
    if (typeof rating !== 'number' || !Number.isFinite(rating)) continue;

    const total = totals.get(episode.parentRatingKey) ?? {
      sum: 0,
      count: 0,
      episodeKeys: new Set<string>(),
    };
    if (total.episodeKeys.has(episode.ratingKey)) continue;

    total.episodeKeys.add(episode.ratingKey);
    total.sum += rating;
    total.count++;
    totals.set(episode.parentRatingKey, total);
  }

  return new Map(
    Array.from(totals, ([seasonRatingKey, total]) => [
      seasonRatingKey,
      Math.round((total.sum / total.count) * 10) / 10,
    ])
  );
}

import type PlexAPI from '@server/api/plexapi';
import type { PlexLibraryItem } from '@server/api/plexapi';
import { placeholderContextService } from '@server/lib/placeholders/services/PlaceholderContextService';

export const PLACEHOLDER_SEASON_SKIP_MESSAGE =
  'Placeholder season has no poster of its own';

type SeasonLike = Pick<PlexLibraryItem, 'ratingKey'> & { thumb?: unknown };

export function hasOwnSeasonPoster(season: SeasonLike): boolean {
  return (
    typeof season.thumb === 'string' &&
    season.thumb.startsWith(`/library/metadata/${season.ratingKey}/`)
  );
}

export function shouldSkipPlaceholderSeason(
  season: SeasonLike,
  parentIsPlaceholder: boolean
): boolean {
  return parentIsPlaceholder && !hasOwnSeasonPoster(season);
}

export function findPlaceholderShowKeys(
  shows: PlexLibraryItem[],
  seasons: PlexLibraryItem[]
): Set<string> {
  const seasonIndexes = new Map<string, number[]>();
  for (const season of seasons) {
    if (!season.parentRatingKey) continue;
    const list = seasonIndexes.get(season.parentRatingKey) ?? [];
    list.push(season.index as number);
    seasonIndexes.set(season.parentRatingKey, list);
  }

  const keys = new Set<string>();
  for (const show of shows) {
    if (show.type !== 'show') continue;
    const indexes = seasonIndexes.get(show.ratingKey);
    const onlySpecials = !!indexes && indexes.every((index) => index === 0);
    if (onlySpecials || placeholderContextService.isPlaceholderItem(show)) {
      keys.add(show.ratingKey);
    }
  }
  return keys;
}

export async function partitionPlaceholderSeasons(
  seasons: PlexLibraryItem[],
  isPlaceholderShow: (showRatingKey: string) => boolean | Promise<boolean>
): Promise<{ kept: PlexLibraryItem[]; skipped: PlexLibraryItem[] }> {
  const verdicts = new Map<string, Promise<boolean>>();
  const kept: PlexLibraryItem[] = [];
  const skipped: PlexLibraryItem[] = [];

  for (const season of seasons) {
    const parentKey = season.parentRatingKey;
    if (!parentKey || hasOwnSeasonPoster(season)) {
      kept.push(season);
      continue;
    }
    if (!verdicts.has(parentKey)) {
      verdicts.set(parentKey, Promise.resolve(isPlaceholderShow(parentKey)));
    }
    const parentIsPlaceholder = await verdicts.get(parentKey);
    (shouldSkipPlaceholderSeason(season, !!parentIsPlaceholder)
      ? skipped
      : kept
    ).push(season);
  }

  return { kept, skipped };
}

/** One metadata call per poster-less season's parent; failures keep the season. */
export function plexPlaceholderShowResolver(
  plexApi: Pick<PlexAPI, 'getMetadata'>
): (showRatingKey: string) => Promise<boolean> {
  return async (showRatingKey) => {
    try {
      const show = await plexApi.getMetadata(showRatingKey, {
        includeChildren: true,
      });
      return placeholderContextService.isPlaceholderItem(show);
    } catch {
      return false;
    }
  };
}

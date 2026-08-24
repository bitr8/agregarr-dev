export interface EpisodeRatingEligibility {
  imdbId?: string;
  rating?: number;
  eligible: boolean;
}

/**
 * Episode cards require their own IMDb rating. A missing GUID, a confirmed
 * null, or a lookup that never populated the batch cache are all deliberately
 * ineligible; callers should restore/use the clean base card in those cases.
 */
export function getEpisodeRatingEligibility(
  guids: { id: string }[] | undefined,
  ratings: ReadonlyMap<string, number | null> | undefined
): EpisodeRatingEligibility {
  const imdbId = guids
    ?.find((guid) => guid.id?.startsWith('imdb://'))
    ?.id.replace('imdb://', '');
  const rating = imdbId ? ratings?.get(imdbId) : undefined;

  return typeof rating === 'number'
    ? { imdbId, rating, eligible: true }
    : { imdbId, eligible: false };
}

export function getUnratedEpisodeAction(
  hasTrackedOverlay: boolean
): 'restore-base' | 'keep-clean' {
  return hasTrackedOverlay ? 'restore-base' : 'keep-clean';
}

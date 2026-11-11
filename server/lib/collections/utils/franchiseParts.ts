const localDateString = (now: Date): string => {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
};

// TMDB sends '' for undated parts; release_date is YYYY-MM-DD so string compare is date order
type FranchisePart = { tmdbId?: number; releaseDate?: string | null };

// An owned film counts as released whatever TMDB's date says
export const countFranchiseParts = (
  movies: readonly FranchisePart[],
  releasedOnly: boolean,
  now: Date = new Date(),
  owned: ReadonlySet<number> = new Set()
): number => {
  if (!releasedOnly) return movies.length;
  const today = localDateString(now);
  return movies.filter(
    (movie) =>
      (movie.tmdbId !== undefined && owned.has(Number(movie.tmdbId))) ||
      (!!movie.releaseDate && movie.releaseDate.slice(0, 10) <= today)
  ).length;
};

// Franchises the released-only pre-filter dropped that the plain count would have kept
export const franchisesWithTooFewReleased = <
  T extends { movies: readonly FranchisePart[] }
>(
  franchiseMap: ReadonlyMap<number, T>,
  kept: ReadonlyMap<number, T>,
  minItems: number,
  owned: ReadonlySet<number>,
  now: Date = new Date()
): Map<number, number> =>
  new Map(
    [...franchiseMap]
      .filter(
        ([franchiseId, franchiseData]) =>
          !kept.has(franchiseId) && franchiseData.movies.length >= minItems
      )
      .map(([franchiseId, franchiseData]): [number, number] => [
        franchiseId,
        countFranchiseParts(franchiseData.movies, true, now, owned),
      ])
      .filter(([, released]) => released < minItems)
  );

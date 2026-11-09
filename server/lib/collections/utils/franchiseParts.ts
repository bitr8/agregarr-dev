const localDateString = (now: Date): string => {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
};

// TMDB sends '' for undated parts; release_date is YYYY-MM-DD so string compare is date order
export const countFranchiseParts = (
  movies: readonly { releaseDate?: string | null }[],
  releasedOnly: boolean,
  now: Date = new Date()
): number => {
  if (!releasedOnly) return movies.length;
  const today = localDateString(now);
  return movies.filter(
    (movie) => !!movie.releaseDate && movie.releaseDate.slice(0, 10) <= today
  ).length;
};

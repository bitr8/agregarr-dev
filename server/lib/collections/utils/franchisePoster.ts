import type { TmdbImage } from '@server/api/themoviedb/interfaces';

// TMDB image languages are ISO-639-1; the setting can be a locale such as sv-SE
export const toImageLanguage = (language: string): string =>
  language.split(/[-_]/)[0].toLowerCase();

// Language order: configured, en, no-language. Within one language: highest vote_average, then vote_count.
export const pickFranchisePoster = (
  posters: readonly Pick<
    TmdbImage,
    'iso_639_1' | 'file_path' | 'vote_average' | 'vote_count'
  >[],
  language: string
): string | undefined => {
  const order: (string | null)[] = [toImageLanguage(language), 'en', null];

  for (const wanted of [...new Set(order)]) {
    const best = posters
      .filter((poster) => (poster.iso_639_1 ?? null) === wanted)
      .sort(
        (a, b) => b.vote_average - a.vote_average || b.vote_count - a.vote_count
      )[0];
    if (best) return best.file_path;
  }
  return undefined;
};

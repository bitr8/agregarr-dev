export const ANIME_KEYWORD_ID = 210024;

// TMDB rejects page numbers above 500 with a 400
export const TMDB_MAX_PAGE = 500;

export const isLastTmdbPage = (
  page: number,
  data: { total_pages?: number },
  pageLength: number
): boolean =>
  Number.isFinite(data.total_pages) && (data.total_pages as number) > 0
    ? page >= (data.total_pages as number)
    : pageLength < 20;

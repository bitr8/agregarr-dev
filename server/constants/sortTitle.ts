// Shared with the client (src/utils/collections/sortTitle.ts), so keep this file dependency-free.

export const LEADING_ARTICLE_PATTERN = /^(The|A|An)\s+(.+)$/i;

// What Plex drops before sorting. Explicit ranges, not \p{P} (the client toolchain can't parse it); emoji are kept.
export const LEADING_PUNCTUATION_PATTERN =
  /^[\s\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E\u00A1\u00BF\u2010-\u2027]+/;

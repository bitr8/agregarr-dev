// Shared with the client (src/utils/collections/sortTitle.ts), so keep this file dependency-free.

export const LEADING_ARTICLE_PATTERN = /^(The|A|An)\s+(.+)$/i;

// What Plex drops before sorting. Explicit ranges, not \p{P} (the client toolchain can't parse it); emoji are kept.
export const LEADING_PUNCTUATION_PATTERN =
  /^[\s\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E\u00A1\u00BF\u2010-\u2027]+/;

export type CollectionSuffixMode = 'leave' | 'strip' | 'add';

const COLLECTION_NAME_SUFFIX = ' Collection';
const TRAILING_SUFFIX_PATTERN = /\s+collection$/i;

// Read from the title, not a stored original, so both directions are idempotent; absent means 'leave'.
export function applyCollectionSuffix(
  title: string,
  mode: CollectionSuffixMode | undefined
): string {
  const trimmed = title.trimEnd();
  const hasSuffix = TRAILING_SUFFIX_PATTERN.test(trimmed);
  if (mode === 'strip' && hasSuffix) {
    let stripped = trimmed;
    while (TRAILING_SUFFIX_PATTERN.test(stripped)) {
      stripped = stripped.replace(TRAILING_SUFFIX_PATTERN, '');
    }
    return stripped || title;
  }
  if (
    mode === 'add' &&
    trimmed &&
    !hasSuffix &&
    trimmed.toLowerCase() !== 'collection'
  ) {
    return `${trimmed}${COLLECTION_NAME_SUFFIX}`;
  }
  return title;
}

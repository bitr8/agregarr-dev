// Shared with the client (src/utils/collections/sortTitle.ts), so keep this file dependency-free.

export const LEADING_ARTICLE_PATTERN = /^(The|A|An)\s+(.+)$/i;

// What Plex drops before sorting. Explicit ranges, not \p{P} (the client toolchain can't parse it); emoji are kept.
export const LEADING_PUNCTUATION_PATTERN =
  /^[\s\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E\u00A1\u00BF\u2010-\u2027]+/;

export type CollectionSuffixMode = 'leave' | 'strip' | 'add';

const COLLECTION_NAME_SUFFIX = ' Collection';

// Read from the title, not a stored original, so both directions are idempotent; absent means 'leave'.
export function applyCollectionSuffix(
  title: string,
  mode: CollectionSuffixMode | undefined
): string {
  const trimmed = title.trimEnd();
  const hasSuffix = trimmed.endsWith(COLLECTION_NAME_SUFFIX);
  if (mode === 'strip' && hasSuffix) {
    return trimmed.slice(0, -COLLECTION_NAME_SUFFIX.length).trimEnd() || title;
  }
  if (mode === 'add' && trimmed && !hasSuffix) {
    return `${trimmed}${COLLECTION_NAME_SUFFIX}`;
  }
  return title;
}

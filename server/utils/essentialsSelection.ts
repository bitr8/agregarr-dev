export type EssentialsSelectionMode = 'include' | 'exclude';

export const resolveSelectionMode = (
  selectionMode: EssentialsSelectionMode | undefined,
  includeValues: string[] | undefined
): EssentialsSelectionMode =>
  selectionMode ?? (includeValues !== undefined ? 'include' : 'exclude');

export const filterEssentialsValues = <T extends { key: string }>(
  values: T[],
  mode: EssentialsSelectionMode,
  includeValues: string[],
  excludeValues: string[]
): T[] =>
  mode === 'include'
    ? values.filter((v) => includeValues.includes(v.key))
    : values.filter((v) => !excludeValues.includes(v.key));

export const renderEssentialsTitle = (
  template: string,
  valueTitle: string,
  mediaType: 'movie' | 'tv',
  subtype?: string
): string => {
  const singular = mediaType === 'movie' ? 'Movie' : 'TV Show';
  const plural = mediaType === 'movie' ? 'Movies' : 'TV Shows';
  return template
    .replace(/{mediaType}s/g, plural)
    .replace(/{mediaType}/g, singular)
    .replace(/{subtype}/g, subtype ?? '{subtype}')
    .replace(/{value}/g, valueTitle);
};

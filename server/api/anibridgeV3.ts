export interface AnimeProviderIds {
  tvdb?: string;
  tmdb?: string;
  imdb?: string;
}

export type MediaType = 'movie' | 'tv';
// An absent media type has no target. A null target has conflicting provider IDs.
export type AnimeMapping = Partial<
  Record<MediaType, AnimeProviderIds | null>
> & {
  anilistIds?: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseProviderTarget(target: string) {
  const match = /^(tmdb|tvdb|imdb)_(movie|show):([^:]+)(?::s(\d+))?$/.exec(
    target
  );
  if (!match) return;

  const [, provider, kind, id, season] = match;
  if (kind === 'movie' && season !== undefined) return;
  const validId =
    provider === 'imdb'
      ? /^tt\d+$/.test(id)
      : /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id));
  if (!validId) return;

  const mediaType: MediaType = kind === 'show' ? 'tv' : 'movie';
  return { mediaType, provider: provider as keyof AnimeProviderIds, id };
}

function parseEpisodeMappings(
  targets: Record<string, unknown>,
  isMalRow: boolean
): AnimeMapping {
  const mapping: AnimeMapping = {};
  for (const [target, ranges] of Object.entries(targets)) {
    if (!isRecord(ranges)) continue;
    const hasEpisodes = Object.values(ranges).some(
      (range) => typeof range === 'string' && range.length > 0
    );
    if (!hasEpisodes) continue;

    const alias = isMalRow && /^anilist:([1-9]\d*)$/.exec(target);
    if (alias) {
      (mapping.anilistIds ??= []).push(alias[1]);
      continue;
    }
    const parsed = parseProviderTarget(target);
    if (!parsed) continue;
    const { mediaType, provider, id } = parsed;
    const ids = mapping[mediaType];
    if (ids === null) continue;

    // Different seasons can name the same series. Conflicting titles block this media type.
    if (ids?.[provider] && ids[provider] !== id) {
      mapping[mediaType] = null;
    } else {
      mapping[mediaType] = { ...ids, [provider]: id };
    }
  }
  return mapping;
}

export function parseMappings(data: unknown): Map<string, AnimeMapping> {
  if (
    !isRecord(data) ||
    !isRecord(data.$meta) ||
    typeof data.$meta.schema_version !== 'string' ||
    !data.$meta.schema_version.startsWith('3.')
  ) {
    throw new Error('Unsupported AniBridge mapping schema');
  }

  const result = new Map<string, AnimeMapping>();
  let hasUsableAniListMapping = false;
  let hasUsableMalMapping = false;
  for (const [source, targets] of Object.entries(data)) {
    if (
      !/^(?:(?:anilist|mal):[1-9]\d*|anidb:[1-9]\d*:R)$/.test(source) ||
      !isRecord(targets)
    ) {
      continue;
    }

    const mapping = parseEpisodeMappings(targets, source.startsWith('mal:'));
    if (!Object.keys(mapping).length) continue;
    result.set(source, mapping);
    if (mapping.tv || mapping.movie) {
      if (source.startsWith('anilist:')) hasUsableAniListMapping = true;
      if (source.startsWith('mal:')) hasUsableMalMapping = true;
    }
  }
  if (!hasUsableAniListMapping) {
    throw new Error('AniBridge mappings contain no usable AniList entries');
  }
  if (!hasUsableMalMapping)
    throw new Error('AniBridge mappings contain no usable MAL entries');
  return result;
}

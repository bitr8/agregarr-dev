export interface AnimeProviderIds {
  tvdb?: string;
  tmdb?: string;
  imdb?: string;
}

type MediaType = 'movie' | 'tv';
type AnimeMapping = Partial<Record<MediaType, AnimeProviderIds | null>>;

let mappings = new Map<string, AnimeMapping>();
let loadedAt = 0;
let loadInFlight: Promise<void> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMappings(data: unknown): Map<string, AnimeMapping> {
  if (
    !isRecord(data) ||
    !isRecord(data.$meta) ||
    typeof data.$meta.schema_version !== 'string' ||
    !data.$meta.schema_version.startsWith('3.')
  ) {
    throw new Error('Unsupported AniBridge mapping schema');
  }

  const result = new Map<string, AnimeMapping>();
  let hasAniList = false;
  for (const [source, targets] of Object.entries(data)) {
    if (
      !/^(?:(?:anilist|mal):[1-9]\d*|anidb:[1-9]\d*:R)$/.test(source) ||
      !isRecord(targets)
    )
      continue;
    const mapping: AnimeMapping = {};
    for (const [target, ranges] of Object.entries(targets)) {
      if (
        !isRecord(ranges) ||
        !Object.values(ranges).some(
          (range) => typeof range === 'string' && range.length > 0
        )
      )
        continue;
      const match = /^(tmdb|tvdb|imdb)_(movie|show):([^:]+)(?::s(\d+))?$/.exec(
        target
      );
      if (!match) continue;
      const [, provider, kind, id, season] = match;
      if (kind === 'movie' && season !== undefined) continue;
      if (
        provider === 'imdb'
          ? !/^tt\d+$/.test(id)
          : !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))
      )
        continue;
      const type = kind === 'show' ? 'tv' : 'movie';
      if (mapping[type] === null) continue;
      const ids = mapping[type] ?? {};
      const key = provider as keyof AnimeProviderIds;
      // Multiple seasons of one series are safe; distinct titles in one namespace are ambiguous.
      mapping[type] =
        ids[key] && ids[key] !== id ? null : { ...ids, [key]: id };
    }
    if (Object.keys(mapping).length) {
      result.set(source, mapping);
      if (source.startsWith('anilist:') && (mapping.tv || mapping.movie))
        hasAniList = true;
    }
  }
  if (!hasAniList)
    throw new Error('AniBridge mappings contain no usable AniList entries');
  return result;
}

// Maximum allowed response size (50MB - the mapping file is typically ~10-20MB)
const MAX_RESPONSE_SIZE = 50 * 1024 * 1024;
// Request timeout (30 seconds)
const FETCH_TIMEOUT_MS = 30000;

export async function loadAnimeIds(
  url = 'https://github.com/anibridge/anibridge-mappings/releases/download/v3/mappings.min.json'
): Promise<void> {
  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      // be explicit that we want fresh-ish
      cache: 'no-store' as RequestCache,
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`Anime-IDs fetch failed: ${res.status}`);

    // Check content-length if provided to reject obviously oversized responses
    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
      throw new Error(
        `Anime-IDs response too large: ${contentLength} bytes (max: ${MAX_RESPONSE_SIZE})`
      );
    }

    // Stream response with size enforcement to prevent memory exhaustion
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error('Anime-IDs response body is not readable');
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      // eslint-disable-next-line no-constant-condition -- standard streaming read pattern
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalBytes += value.length;
        if (totalBytes > MAX_RESPONSE_SIZE) {
          controller.abort();
          throw new Error(
            `Anime-IDs response too large: exceeded ${MAX_RESPONSE_SIZE} bytes during download`
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    // Combine chunks and decode as UTF-8
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    const text = new TextDecoder().decode(combined);

    mappings = parseMappings(JSON.parse(text));
    loadedAt = Date.now();
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function ensureAnimeIdsLoaded(
  ttlMs = 12 * 60 * 60 * 1000
): Promise<void> {
  if (mappings.size && Date.now() - loadedAt <= ttlMs) return;
  loadInFlight ??= loadAnimeIds().finally(() => (loadInFlight = null));
  return loadInFlight;
}

export function lookupByAniList(
  id: number,
  type: MediaType,
  malId?: number | null
) {
  const mapped = mappings.get(`anilist:${id}`)?.[type];
  return mapped === undefined && malId ? lookupByMal(malId, type) : mapped;
}

export function lookupByMal(id: number, type: MediaType) {
  return mappings.get(`mal:${id}`)?.[type];
}

export function lookupByAniDB(id: number, type: MediaType) {
  return mappings.get(`anidb:${id}:R`)?.[type];
}

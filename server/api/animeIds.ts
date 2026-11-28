import {
  parseMappings,
  type AnimeMapping,
  type MediaType,
} from './anibridgeV3';
export type { AnimeProviderIds } from './anibridgeV3';

let mappings = new Map<string, AnimeMapping>();
let loadedAt = 0;
let loadInFlight: Promise<void> | null = null;

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

export function aniListIdsForMal(id: number) {
  return mappings.get(`mal:${id}`)?.anilistIds ?? [];
}

export function lookupByAniDB(id: number, type: MediaType) {
  return mappings.get(`anidb:${id}:R`)?.[type];
}

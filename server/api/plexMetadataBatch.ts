export const PLEX_METADATA_BATCH_SIZE = 50;

interface PlexMetadataBatchOptions {
  chunkSize?: number;
  minChunkSize?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  onRetry?: (keys: string[], error: unknown, attempt: number) => void;
  onFailure?: (keys: string[], error: unknown) => void;
}

function isTransientPlexError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
  const message = error instanceof Error ? error.message : String(error);

  return (
    ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE'].includes(code) ||
    /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|socket hang up|\b429\b|\b5\d\d\b/i.test(
      message
    )
  );
}

const wait = (delayMs: number): Promise<void> =>
  delayMs > 0
    ? new Promise((resolve) => setTimeout(resolve, delayMs))
    : Promise.resolve();

/**
 * Fetch Plex metadata with bounded response sizes. Transient failures are
 * retried, then recursively split so one oversized or malformed response
 * cannot discard metadata for an entire group of otherwise valid items.
 */
export async function fetchPlexMetadataBatches<
  TMetadata extends { ratingKey: string }
>(
  ratingKeys: string[],
  queryChunk: (ratingKeys: string[]) => Promise<TMetadata[]>,
  options: PlexMetadataBatchOptions = {}
): Promise<Map<string, TMetadata>> {
  const result = new Map<string, TMetadata>();
  const uniqueKeys = Array.from(new Set(ratingKeys));
  if (uniqueKeys.length === 0) return result;

  const chunkSize = Math.max(1, options.chunkSize ?? PLEX_METADATA_BATCH_SIZE);
  const minChunkSize = Math.max(1, options.minChunkSize ?? 10);
  const maxRetries = Math.max(0, options.maxRetries ?? 1);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 150);

  const fetchChunk = async (keys: string[]): Promise<void> => {
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const items = await queryChunk(keys);
        for (const item of items) result.set(item.ratingKey, item);
        return;
      } catch (error) {
        lastError = error;
        if (attempt >= maxRetries || !isTransientPlexError(error)) break;

        options.onRetry?.(keys, error, attempt + 1);
        await wait(retryDelayMs * 2 ** attempt);
      }
    }

    if (keys.length > minChunkSize) {
      const midpoint = Math.ceil(keys.length / 2);
      await fetchChunk(keys.slice(0, midpoint));
      await fetchChunk(keys.slice(midpoint));
      return;
    }

    options.onFailure?.(keys, lastError);
  };

  for (let offset = 0; offset < uniqueKeys.length; offset += chunkSize) {
    await fetchChunk(uniqueKeys.slice(offset, offset + chunkSize));
  }

  return result;
}

import { describe, expect, it, vi } from 'vitest';
import {
  fetchPlexMetadataBatches,
  PLEX_METADATA_BATCH_SIZE,
} from './plexMetadataBatch';

describe('resilient Plex metadata batching', () => {
  it('uses bounded 50-item requests and deduplicates keys', async () => {
    const keys = [
      ...Array.from({ length: 125 }, (_, index) => String(index + 1)),
      '1',
    ];
    const query = vi.fn(async (chunk: string[]) =>
      chunk.map((ratingKey) => ({ ratingKey }))
    );

    const result = await fetchPlexMetadataBatches(keys, query, {
      retryDelayMs: 0,
    });

    expect(PLEX_METADATA_BATCH_SIZE).toBe(50);
    expect(query.mock.calls.map(([chunk]) => chunk.length)).toEqual([
      50, 50, 25,
    ]);
    expect(result.size).toBe(125);
  });

  it('retries a transient reset before continuing', async () => {
    const reset = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET',
    });
    const query = vi
      .fn<(keys: string[]) => Promise<{ ratingKey: string }[]>>()
      .mockRejectedValueOnce(reset)
      .mockImplementation(async (keys) =>
        keys.map((ratingKey) => ({ ratingKey }))
      );
    const onRetry = vi.fn();

    const result = await fetchPlexMetadataBatches(['1', '2'], query, {
      retryDelayMs: 0,
      onRetry,
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(result.size).toBe(2);
  });

  it('splits a persistently failing group and preserves valid neighbors', async () => {
    const query = vi.fn(async (keys: string[]) => {
      if (keys.includes('bad')) throw new Error('invalid metadata key');
      return keys.map((ratingKey) => ({ ratingKey }));
    });
    const onFailure = vi.fn();

    const result = await fetchPlexMetadataBatches(
      ['1', '2', 'bad', '3'],
      query,
      {
        chunkSize: 4,
        minChunkSize: 1,
        maxRetries: 0,
        retryDelayMs: 0,
        onFailure,
      }
    );

    expect(Array.from(result.keys())).toEqual(['1', '2', '3']);
    expect(onFailure).toHaveBeenCalledWith(['bad'], expect.any(Error));
  });
});

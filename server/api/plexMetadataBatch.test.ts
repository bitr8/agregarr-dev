import { describe, expect, it, vi } from 'vitest';
import {
  fetchPlexMetadataBatches,
  PLEX_METADATA_BATCH_SIZE,
} from './plexMetadataBatch';

describe('resilient Plex metadata batching', () => {
  it.each([401, 403])(
    'does not retry HTTP %i because a URL contains 500',
    async (status) => {
      const query = vi.fn(async () => {
        throw new Error(
          `response code: ${status} (/library/metadata/500/children)`
        );
      });
      await fetchPlexMetadataBatches(['500', '501'], query, {
        minChunkSize: 1,
        maxRetries: 2,
        retryDelayMs: 0,
      });
      expect(query).toHaveBeenCalledOnce();
    }
  );

  it.each([408, 429, 503])(
    'retries a structured HTTP %i even without a status in the message',
    async (status) => {
      const query = vi
        .fn<(keys: string[]) => Promise<{ ratingKey: string }[]>>()
        .mockRejectedValueOnce(
          Object.assign(new Error('Plex request failed'), {
            response: { status },
          })
        )
        .mockResolvedValue([{ ratingKey: '1' }]);
      const result = await fetchPlexMetadataBatches(['1'], query, {
        retryDelayMs: 0,
      });
      expect(query).toHaveBeenCalledTimes(2);
      expect(result.size).toBe(1);
    }
  );

  it('retries and splits resets whose URL contains a 4xx-shaped rating key', async () => {
    const query = vi.fn(async (keys: string[]) => {
      if (keys.length > 1)
        throw new Error('ECONNRESET /library/metadata/478/children');
      return keys.map((ratingKey) => ({ ratingKey }));
    });
    const result = await fetchPlexMetadataBatches(['478', '479'], query, {
      chunkSize: 2,
      minChunkSize: 1,
      maxRetries: 1,
      retryDelayMs: 0,
    });
    expect(query.mock.calls.map(([keys]) => keys.length)).toEqual([2, 2, 1, 1]);
    expect(result.size).toBe(2);
  });

  it('does not split a message-only Plex authorization response', async () => {
    const query = vi.fn(async () => {
      throw new Error(
        'Plex Server didnt respond with a valid 2xx status code, response code: 401'
      );
    });
    await fetchPlexMetadataBatches(['1', '2'], query, {
      minChunkSize: 1,
      retryDelayMs: 0,
    });
    expect(query).toHaveBeenCalledOnce();
  });

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

  it('does not split a non-retryable Plex authorization failure', async () => {
    const unauthorized = Object.assign(new Error('Request failed with 401'), {
      response: { status: 401 },
    });
    const query = vi.fn(async () => {
      throw unauthorized;
    });
    const onFailure = vi.fn();

    await fetchPlexMetadataBatches(['1', '2', '3', '4'], query, {
      chunkSize: 4,
      minChunkSize: 1,
      maxRetries: 2,
      retryDelayMs: 0,
      onFailure,
    });

    expect(query).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith(['1', '2', '3', '4'], unauthorized);
  });
});

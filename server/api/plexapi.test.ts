import { describe, expect, it, vi } from 'vitest';

/**
 * Tests for getMetadataBatch chunking logic.
 * Since PlexAPI has deep dependencies (plex-api, settings, etc.), we test the
 * core algorithm in isolation rather than instantiating the full class.
 */
describe('getMetadataBatch chunking logic', () => {
  const CHUNK_SIZE = 200;

  // Simulate the chunking algorithm from getMetadataBatch
  async function batchFetch(
    ratingKeys: string[],
    queryFn: (url: string) => Promise<{ ratingKey: string; title: string }[]>
  ): Promise<Map<string, { ratingKey: string; title: string }>> {
    const result = new Map<string, { ratingKey: string; title: string }>();
    if (ratingKeys.length === 0) return result;

    for (let i = 0; i < ratingKeys.length; i += CHUNK_SIZE) {
      const chunk = ratingKeys.slice(i, i + CHUNK_SIZE);
      try {
        const items = await queryFn(`/library/metadata/${chunk.join(',')}`);
        for (const item of items) {
          result.set(item.ratingKey, item);
        }
      } catch {
        // Chunk failed — items in this chunk will fall back to individual fetch
      }
    }

    return result;
  }

  it('should return empty Map for empty input', async () => {
    const queryFn = vi.fn();
    const result = await batchFetch([], queryFn);
    expect(result.size).toBe(0);
    expect(queryFn).not.toHaveBeenCalled();
  });

  it('should fetch all items in a single call when under chunk size', async () => {
    const queryFn = vi.fn().mockResolvedValueOnce([
      { ratingKey: '100', title: 'Movie A' },
      { ratingKey: '200', title: 'Movie B' },
    ]);

    const result = await batchFetch(['100', '200'], queryFn);

    expect(result.size).toBe(2);
    expect(result.get('100')?.title).toBe('Movie A');
    expect(result.get('200')?.title).toBe('Movie B');
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(queryFn).toHaveBeenCalledWith('/library/metadata/100,200');
  });

  it('should chunk requests when over 200 items', async () => {
    const ratingKeys = Array.from({ length: 250 }, (_, i) => String(1000 + i));

    const queryFn = vi.fn().mockImplementation(async (url: string) => {
      const keys = url.replace('/library/metadata/', '').split(',');
      return keys.map((rk) => ({ ratingKey: rk, title: `Item ${rk}` }));
    });

    const result = await batchFetch(ratingKeys, queryFn);

    expect(result.size).toBe(250);
    expect(queryFn).toHaveBeenCalledTimes(2);

    // Verify first chunk has 200 keys
    const firstUrl = queryFn.mock.calls[0][0] as string;
    const firstKeys = firstUrl.replace('/library/metadata/', '').split(',');
    expect(firstKeys).toHaveLength(200);

    // Verify second chunk has 50 keys
    const secondUrl = queryFn.mock.calls[1][0] as string;
    const secondKeys = secondUrl.replace('/library/metadata/', '').split(',');
    expect(secondKeys).toHaveLength(50);
  });

  it('should return partial results when one chunk fails', async () => {
    const ratingKeys = Array.from({ length: 250 }, (_, i) => String(1000 + i));

    const queryFn = vi
      .fn()
      .mockImplementationOnce(async (url: string) => {
        const keys = url.replace('/library/metadata/', '').split(',');
        return keys.map((rk) => ({ ratingKey: rk, title: `Item ${rk}` }));
      })
      .mockRejectedValueOnce(new Error('Plex timeout'));

    const result = await batchFetch(ratingKeys, queryFn);

    // Should have 200 from first chunk, 0 from failed second
    expect(result.size).toBe(200);
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('should handle exactly 200 items in a single chunk', async () => {
    const ratingKeys = Array.from({ length: 200 }, (_, i) => String(1000 + i));

    const queryFn = vi.fn().mockImplementation(async (url: string) => {
      const keys = url.replace('/library/metadata/', '').split(',');
      return keys.map((rk) => ({ ratingKey: rk, title: `Item ${rk}` }));
    });

    const result = await batchFetch(ratingKeys, queryFn);

    expect(result.size).toBe(200);
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('should handle 201 items in exactly 2 chunks', async () => {
    const ratingKeys = Array.from({ length: 201 }, (_, i) => String(1000 + i));

    const queryFn = vi.fn().mockImplementation(async (url: string) => {
      const keys = url.replace('/library/metadata/', '').split(',');
      return keys.map((rk) => ({ ratingKey: rk, title: `Item ${rk}` }));
    });

    const result = await batchFetch(ratingKeys, queryFn);

    expect(result.size).toBe(201);
    expect(queryFn).toHaveBeenCalledTimes(2);

    // Second chunk should have exactly 1 item
    const secondUrl = queryFn.mock.calls[1][0] as string;
    const secondKeys = secondUrl.replace('/library/metadata/', '').split(',');
    expect(secondKeys).toHaveLength(1);
  });
});

/**
 * Tests for the addItemsToCollection read-back verification math
 * (verifyItemsLanded): a PUT that reports success is still only trusted for
 * the ratingKeys the follow-up read actually contains.
 */
describe('addItemsToCollection read-back verification', () => {
  // Mirrors verifyItemsLanded's counting logic against a fake read-back.
  function countVerified(attemptedKeys: string[], currentItems: string[]) {
    const currentSet = new Set(currentItems);
    let verified = 0;
    for (const key of attemptedKeys) {
      if (currentSet.has(key)) verified++;
    }
    return verified;
  }

  it('counts every attempted key present in the read-back', () => {
    const verified = countVerified(['1', '2', '3'], ['3', '1', '2']);
    expect(verified).toBe(3);
  });

  it('undercounts when the read-back is missing an attempted key', () => {
    const verified = countVerified(['1', '2', '3'], ['1', '3']);
    expect(verified).toBe(2);
  });

  it('counts zero when the write claimed success but nothing landed', () => {
    const verified = countVerified(['1', '2'], []);
    expect(verified).toBe(0);
  });
});

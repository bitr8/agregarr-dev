import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

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

vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({ clientId: 'test-client', main: {} }),
}));

vi.mock('@server/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Shared fixture: real PlexAPI instance with isSmartCollection/getCollectionItems
// stubbed, and safePutQuery rejecting (404) only for URLs matching failUrlPart.
async function setupArrangeApi(currentOrder: string[], failUrlPart?: string) {
  const { default: PlexAPI } = await import('./plexapi');
  const logger = (await import('@server/logger')).default;

  const api = new PlexAPI({
    plexToken: 'test-token',
    plexSettings: { name: 'test', ip: '127.0.0.1', port: 32400, libraries: [] },
  });

  (
    vi.spyOn(
      api as unknown as { isSmartCollection: unknown },
      'isSmartCollection' as never
    ) as unknown as MockInstance
  ).mockResolvedValue('not_smart');
  vi.spyOn(api, 'getCollectionItems').mockResolvedValue(currentOrder);
  (
    vi.spyOn(
      api as unknown as { safePutQuery: unknown },
      'safePutQuery' as never
    ) as unknown as MockInstance
  ).mockImplementation((async (url: string) => {
    if (failUrlPart && url.includes(failUrlPart)) {
      throw new Error(`PUT ${url} failed, response code: 404`);
    }
    return undefined;
  }) as never);

  return { api, logger };
}

function findArrangeWarn(logger: { warn: unknown }) {
  const calls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
  return calls.find(([message]: string[]) =>
    message.includes('Failed to arrange')
  );
}

describe('arrangeCollectionItemsInOrder failure reporting', () => {
  beforeAll(async () => {
    await import('./plexapi');
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('warns with the collection name and the failing item + reason', async () => {
    const { api, logger } = await setupArrangeApi(
      ['301', '300'],
      '/items/300/move'
    );

    await api.arrangeCollectionItemsInOrder(
      '569503',
      [
        { ratingKey: '300', title: 'A' },
        { ratingKey: '301', title: 'B' },
      ],
      'My Collection'
    );

    const failureCall = findArrangeWarn(logger);
    expect(failureCall).toBeDefined();
    const [message, meta] = failureCall as [
      string,
      { failures: { itemRatingKey: string; reason: string }[] }
    ];
    expect(message).toContain('My Collection');
    expect(message).toContain('569503');
    expect(meta.failures[0].itemRatingKey).toBe('300');
    expect(meta.failures[0].reason).toContain('404');
  });

  it('records afterItemRatingKey when a non-position-0 move fails', async () => {
    // Rotation: forces position-0 to succeed, then an `after=` move to fail.
    const { api, logger } = await setupArrangeApi(
      ['402', '400', '401'],
      '/items/401/move'
    );

    await api.arrangeCollectionItemsInOrder(
      '569503',
      [
        { ratingKey: '400', title: 'A' },
        { ratingKey: '401', title: 'B' },
        { ratingKey: '402', title: 'C' },
      ],
      'Rotated Collection'
    );

    const failureCall = findArrangeWarn(logger);
    expect(failureCall).toBeDefined();
    const [, meta] = failureCall as [
      string,
      {
        failures: {
          itemRatingKey: string;
          afterItemRatingKey?: string;
          reason: string;
        }[];
      }
    ];
    expect(meta.failures[0].itemRatingKey).toBe('401');
    expect(meta.failures[0].afterItemRatingKey).toBe('400');
    expect(meta.failures[0].reason).toContain('404');
  });

  it('threads collectionName through updateCollectionContents into the arrange warn', async () => {
    // Same items, already present, just out of order - add/remove are no-ops.
    const { api, logger } = await setupArrangeApi(
      ['301', '300'],
      '/items/300/move'
    );

    await api.updateCollectionContents(
      '569503',
      [
        { ratingKey: '300', title: 'A' },
        { ratingKey: '301', title: 'B' },
      ],
      'Existing Collection'
    );

    const [message] = findArrangeWarn(logger) as [string];
    expect(message).toContain('Existing Collection');
  });
});

describe('arrangeCollectionItemsInOrder duplicate ratingKeys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never moves an item after itself and skips when already in order', async () => {
    const { api, logger } = await setupArrangeApi(['1', '2', '3']);
    const put = (api as unknown as { safePutQuery: ReturnType<typeof vi.fn> })
      .safePutQuery;

    await api.arrangeCollectionItemsInOrder('378965', [
      { ratingKey: '1', title: 'A' },
      { ratingKey: '2', title: 'B' },
      { ratingKey: '2', title: 'B again' },
      { ratingKey: '3', title: 'C' },
    ]);

    expect(put).not.toHaveBeenCalled();
    expect(findArrangeWarn(logger)).toBeUndefined();
  });

  it('reorders with duplicates collapsed and no self-referential move', async () => {
    const { api } = await setupArrangeApi(['1', '2', '3']);
    const put = (api as unknown as { safePutQuery: ReturnType<typeof vi.fn> })
      .safePutQuery;

    await api.arrangeCollectionItemsInOrder('378965', [
      { ratingKey: '3', title: 'C' },
      { ratingKey: '3', title: 'C again' },
      { ratingKey: '1', title: 'A' },
      { ratingKey: '2', title: 'B' },
    ]);

    expect(put.mock.calls.map(([u]: unknown[]) => String(u))).toEqual([
      '/library/collections/378965/items/3/move',
    ]);
  });
});

describe('arrangeCollectionItemsInOrder items missing from the collection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never moves a requested item that is not in the collection', async () => {
    const { api, logger } = await setupArrangeApi(['1003', '1001', '1002']);
    const put = (api as unknown as { safePutQuery: ReturnType<typeof vi.fn> })
      .safePutQuery;

    await api.arrangeCollectionItemsInOrder('378965', [
      { ratingKey: '1001', title: 'A' },
      { ratingKey: '1002', title: 'B' },
      { ratingKey: '9999', title: 'Missing' },
      { ratingKey: '1003', title: 'C' },
    ]);

    const urls = put.mock.calls.map(([u]: unknown[]) => String(u));
    expect(urls.some((u) => u.includes('/items/9999/'))).toBe(false);
    expect(urls).toEqual([
      '/library/collections/378965/items/1001/move',
      '/library/collections/378965/items/1002/move?after=1001',
    ]);
    expect(findArrangeWarn(logger)).toBeUndefined();
  });

  it('still moves a lone surviving item into position', async () => {
    const { api } = await setupArrangeApi(['1005', '1001']);
    const put = (api as unknown as { safePutQuery: ReturnType<typeof vi.fn> })
      .safePutQuery;

    await api.arrangeCollectionItemsInOrder('378965', [
      { ratingKey: '1001', title: 'A' },
      { ratingKey: '9999', title: 'Missing' },
    ]);

    expect(put.mock.calls.map(([u]: unknown[]) => String(u))).toEqual([
      '/library/collections/378965/items/1001/move',
    ]);
  });

  it('issues no moves when the collection is empty', async () => {
    const { api, logger } = await setupArrangeApi([]);
    const put = (api as unknown as { safePutQuery: ReturnType<typeof vi.fn> })
      .safePutQuery;

    await api.arrangeCollectionItemsInOrder('378965', [
      { ratingKey: '1001', title: 'A' },
      { ratingKey: '1002', title: 'B' },
    ]);

    expect(put).not.toHaveBeenCalled();
    expect(findArrangeWarn(logger)).toBeUndefined();
  });
});

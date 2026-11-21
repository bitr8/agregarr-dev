import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSettings = vi.fn();
vi.mock('@server/lib/settings', () => ({
  getSettings: () => mockGetSettings(),
}));

vi.mock(
  '@server/lib/collections/services/PreExistingCollectionConfigService',
  () => ({
    preExistingCollectionConfigService: { getConfigs: () => [] },
  })
);

const mockFindOne = vi.fn();
const mockFindByIds = vi.fn();
vi.mock('@server/datasource', () => ({
  getRepository: (entity: { name: string }) =>
    entity.name === 'OverlayLibraryConfig'
      ? { findOne: mockFindOne }
      : { findByIds: mockFindByIds },
}));

vi.mock('@server/lib/collections/core/CollectionUtilities', () => ({
  getAdminUser: () => Promise.resolve({ plexToken: 'token' }),
}));

const mockGetCollectionItemsOrThrow = vi.fn();
const mockGetMetadataBatch = vi.fn();
vi.mock('@server/api/plexapi', () => ({
  default: class {
    getCollectionItemsOrThrow = mockGetCollectionItemsOrThrow;
    getMetadataBatch = mockGetMetadataBatch;
  },
}));

vi.mock('@server/lib/metadata/MetadataTrackingService', () => ({
  default: { getItemMetadata: () => Promise.resolve(undefined) },
}));

vi.mock('@server/lib/placeholders/services/PlaceholderContextService', () => ({
  placeholderContextService: {
    isPlaceholderItemAsync: () => Promise.resolve(false),
  },
}));

vi.mock('./OverlayContextBuilder', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildRenderContext: () =>
    Promise.resolve({ context: { title: 'Item' }, criticalApiFailed: false }),
}));

const mockHash = vi.fn();
vi.mock('@server/utils/metadataHashing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  calculateOverlayInputHash: (config: unknown) => mockHash(config),
}));

import { overlayLibraryService } from './OverlayLibraryService';

type Internals = {
  collectionRankCache: Map<string, Map<string, number>>;
  refreshCollectionRanks: (api: unknown, templates: unknown[]) => Promise<void>;
  sonarrSeriesCache?: Map<string, unknown>;
  runningLibraries: Map<string, { state: string }>;
  applyOverlaysToItem: (...args: unknown[]) => Promise<unknown>;
  applyOverlaysToCollectionItems: (
    items: string[],
    libraryId: string,
    options?: { skipRankRefresh?: boolean }
  ) => Promise<void>;
};
const svc = overlayLibraryService as unknown as Internals;

const rankTemplate = {
  id: 1,
  getTemplateData: () => ({
    elements: [
      {
        type: 'variable',
        properties: {
          segments: [{ type: 'variable', field: 'collectionRank:col-1' }],
        },
      },
    ],
  }),
  getApplicationCondition: () => null,
};

const plexApi = {
  getCollectionItemsOrThrow: (key: string) =>
    mockGetCollectionItemsOrThrow(key),
};

beforeEach(() => {
  vi.clearAllMocks();
  svc.collectionRankCache.clear();
  mockGetSettings.mockReturnValue({
    plex: { collectionConfigs: [{ id: 'col-1', collectionRatingKey: '900' }] },
    overlays: {},
  });
});

describe('collection rank cache refresh', () => {
  it('clears ranks when the collection is genuinely empty', async () => {
    mockGetCollectionItemsOrThrow.mockResolvedValueOnce(['a', 'b']);
    await svc.refreshCollectionRanks(plexApi, [rankTemplate]);
    expect(svc.collectionRankCache.get('col-1')?.get('a')).toBe(1);

    mockGetCollectionItemsOrThrow.mockResolvedValueOnce([]);
    await svc.refreshCollectionRanks(plexApi, [rankTemplate]);
    expect(svc.collectionRankCache.get('col-1')?.get('a')).toBeUndefined();
  });

  it('keeps the last known ranks when the fetch fails', async () => {
    mockGetCollectionItemsOrThrow.mockResolvedValueOnce(['a', 'b']);
    await svc.refreshCollectionRanks(plexApi, [rankTemplate]);

    mockGetCollectionItemsOrThrow.mockRejectedValueOnce(new Error('plex down'));
    await svc.refreshCollectionRanks(plexApi, [rankTemplate]);
    expect(svc.collectionRankCache.get('col-1')?.get('b')).toBe(2);
  });

  it('fetches only on the first batch of a job', async () => {
    mockFindOne.mockResolvedValue({
      mediaType: 'movie',
      enabledOverlays: [{ templateId: 1, enabled: true, layerOrder: 0 }],
    });
    mockFindByIds.mockResolvedValue([rankTemplate]);
    mockGetCollectionItemsOrThrow.mockResolvedValue(['a']);
    mockGetMetadataBatch.mockRejectedValue(new Error('stop here'));

    await svc
      .applyOverlaysToCollectionItems(['a'], 'lib')
      .catch(() => undefined);
    expect(mockGetCollectionItemsOrThrow).toHaveBeenCalledTimes(1);

    await svc
      .applyOverlaysToCollectionItems(['a'], 'lib', { skipRankRefresh: true })
      .catch(() => undefined);
    expect(mockGetCollectionItemsOrThrow).toHaveBeenCalledTimes(1);
  });

  it('puts the rank into the context handed to the overlay hash', async () => {
    mockFindOne.mockResolvedValue({
      mediaType: 'movie',
      enabledOverlays: [{ templateId: 1, enabled: true, layerOrder: 0 }],
    });
    mockFindByIds.mockResolvedValue([rankTemplate]);
    mockGetCollectionItemsOrThrow.mockResolvedValue(['x', 'a']);
    mockGetMetadataBatch.mockRejectedValue(new Error('stop here'));
    await svc
      .applyOverlaysToCollectionItems(['a'], 'lib')
      .catch(() => undefined);

    mockHash.mockImplementation(() => {
      throw new Error('captured');
    });
    await svc
      .applyOverlaysToItem(
        {},
        { ratingKey: 'a', title: 'Item', type: 'movie', Guid: [] },
        [rankTemplate],
        'movie',
        'lib',
        'Lib',
        undefined,
        { fallback: false }
      )
      .catch(() => undefined);

    expect(mockHash).toHaveBeenCalledTimes(1);
    expect(mockHash.mock.calls[0][0].context['collectionRank:col-1']).toBe(2);
  });

  it('reads collection membership from the job it was handed, not the instance', async () => {
    mockHash.mockImplementation(() => {
      throw new Error('captured');
    });
    const item = { ratingKey: 'a', title: 'Item', type: 'movie', Guid: [] };
    const run = (membership?: Map<string, string[]>) =>
      svc
        .applyOverlaysToItem(
          {},
          item,
          [rankTemplate],
          'movie',
          'lib',
          'Lib',
          undefined,
          { fallback: false },
          undefined,
          undefined,
          undefined,
          undefined,
          false,
          membership
        )
        .catch(() => undefined);

    await run(new Map([['a', ['col-1']]]));
    await run(undefined);

    expect(mockHash.mock.calls[0][0].context.collection).toEqual(['col-1']);
    expect(mockHash.mock.calls[1][0].context.collection).toBeUndefined();
    expect('collectionMembershipCache' in svc).toBe(false);
  });
});

describe('standalone batch cache lifetime', () => {
  const runBatch = () => {
    mockFindOne.mockResolvedValue(undefined);
    return svc
      .applyOverlaysToCollectionItems(['a'], 'lib')
      .catch(() => undefined);
  };

  it('drops the series cache when no other job is active', async () => {
    svc.sonarrSeriesCache = new Map();
    await runBatch();
    expect(svc.sonarrSeriesCache).toBeUndefined();
  });

  it('keeps it while a full job is running', async () => {
    const cache = new Map();
    svc.sonarrSeriesCache = cache;
    svc.runningLibraries.set('other', { state: 'running' });
    try {
      await runBatch();
      expect(svc.sonarrSeriesCache).toBe(cache);
    } finally {
      svc.runningLibraries.delete('other');
      svc.sonarrSeriesCache = undefined;
    }
  });
});

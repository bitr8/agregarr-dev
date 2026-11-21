import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const mockHash = vi.fn();
vi.mock('@server/utils/metadataHashing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  calculateOverlayInputHash: (config: unknown) => mockHash(config),
}));

// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths -- server tsconfig has no @app alias
import { AVAILABLE_VARIABLES } from '../../../src/components/OverlayEditor/types';
import { overlayLibraryService } from './OverlayLibraryService';

type Internals = {
  applyOverlaysToItem: (...args: unknown[]) => Promise<unknown>;
  applyOverlaysToCollectionItems: (
    items: string[],
    libraryId: string
  ) => Promise<void>;
};
const svc = overlayLibraryService as unknown as Internals;

const FIELDS = (
  Object.values(AVAILABLE_VARIABLES).flat() as { field: string }[]
).map((v) => v.field);

const template = {
  id: 1,
  getTags: () => ['main'],
  getTemplateData: () => ({
    elements: FIELDS.map((field) => ({
      type: 'variable',
      properties: { segments: [{ type: 'variable', field }] },
    })),
  }),
  getApplicationCondition: () => null,
};

const NOW = new Date('2026-09-17T00:00:00.000Z');
const metadata = {
  ratingKey: '10',
  type: 'show',
  title: 'Show',
  guid: 'plex://show/1',
  Guid: [],
  Media: [],
  addedAt: 1_700_000_000,
  updatedAt: 1_700_000_100,
  viewCount: 7,
  lastViewedAt: 1_750_000_000,
  childCount: 4,
};

const captureContext = async (run: () => Promise<unknown>) => {
  mockHash.mockImplementation((config: { context: unknown }) => {
    throw Object.assign(new Error('captured'), { context: config.context });
  });
  mockHash.mockClear();
  await run().catch(() => undefined);
  expect(mockHash).toHaveBeenCalledTimes(1);
  return mockHash.mock.calls[0][0].context as Record<string, unknown>;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockGetSettings.mockReturnValue({
    plex: { collectionConfigs: [], libraries: [] },
    overlays: {},
  });
  mockFindOne.mockResolvedValue({
    mediaType: 'show',
    enabledOverlays: [{ templateId: 1, enabled: true, layerOrder: 0 }],
  });
  mockFindByIds.mockResolvedValue([template]);
  mockGetMetadataBatch.mockResolvedValue(new Map([['10', metadata]]));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('overlay context parity between full sync and collection-triggered apply', () => {
  it('builds the same context for every AVAILABLE_VARIABLES field', async () => {
    const fullSync = await captureContext(() =>
      svc.applyOverlaysToItem(
        {},
        { ...metadata },
        [template],
        'show',
        'lib',
        'Lib',
        undefined,
        { fallback: false }
      )
    );
    const collection = await captureContext(() =>
      svc.applyOverlaysToCollectionItems(['10'], 'lib')
    );

    expect(collection.seasonsAvailable).toBe(4);
    expect(collection.viewCount).toBe(7);
    expect(collection.daysSinceLastPlayed).toBeGreaterThan(0);
    for (const field of FIELDS) {
      expect(collection[field], field).toEqual(fullSync[field]);
    }
  });
});

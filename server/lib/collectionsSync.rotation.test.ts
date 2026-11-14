import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  settings: undefined as unknown,
  order: [] as string[],
  save: vi.fn(),
}));

vi.mock('@server/lib/settings', async (importOriginal) => {
  const actual = (await importOriginal()) as { getSettings: () => unknown };
  return {
    ...actual,
    getSettings: () => h.settings ?? actual.getSettings(),
  };
});

vi.mock('@server/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@server/api/plexapi', () => ({
  default: class {
    clearHubManagementCache = vi.fn();
    getStatus = vi.fn(async () => {
      h.order.push('plex');
      return true;
    });
    recordPhaseTime = vi.fn();
    getAllCollections = vi.fn(async () => []);
  },
}));

vi.mock('@server/lib/collections/core/CollectionUtilities', () => ({
  extractErrorMessage: (e: unknown) =>
    e instanceof Error ? e.message : String(e),
  getAdminUser: async () => ({ plexToken: 'token-x' }),
}));

vi.mock('@server/lib/collections/CollectionSyncProgress', () => ({
  default: new Proxy({}, { get: () => vi.fn() }),
}));

vi.mock('@server/lib/collections/services/CollectionSyncService', () => ({
  collectionSyncService: {
    syncAllConfigurations: vi.fn(async () => {
      h.order.push('configs');
      throw new Error('stop after configs');
    }),
  },
}));

vi.mock('@server/lib/collections/services/CollectionCleanupService', () => ({
  CollectionCleanupService: class {},
}));

vi.mock('@server/lib/collections/services/DiscoveryService', () => ({
  discoveryService: { status: { running: false } },
}));

vi.mock(
  '@server/lib/collections/services/IndividualCollectionScheduler',
  () => ({
    IndividualCollectionScheduler: {
      getLibraryQueuesStatus: () => [],
      setFullSyncRunning: vi.fn(),
      processPendingQueues: vi.fn(async () => undefined),
    },
  })
);

vi.mock('@server/lib/randomizeHomeOrder', () => ({
  default: { status: { running: false } },
}));
vi.mock('@server/lib/collectionsQuickSync', () => ({
  default: { status: { running: false } },
}));
vi.mock('@server/lib/overlayApplication', () => ({
  default: { status: { running: false } },
}));
vi.mock('@server/lib/posterizarrTrigger', () => ({
  default: { busy: false },
}));
vi.mock('@server/lib/placeholders/seerrIgnorePatterns', () => ({
  ensureSeerrIgnorePatterns: vi.fn(async () => undefined),
}));
vi.mock('@server/lib/rotation/rotationApply', () => ({
  default: { status: { running: false }, kick: vi.fn() },
  markVerified: vi.fn(async () => undefined),
}));
vi.mock('@server/routes/reorder', () => ({
  autoReorderLibrary: vi.fn(async () => undefined),
}));
vi.mock('@server/lib/metadata/MetadataTrackingService', () => ({
  default: { getPosterLocalPath: vi.fn(async () => null) },
}));

import collectionsSync from '@server/lib/collectionsSync';
import rotationGroupService from '@server/lib/rotation/RotationGroupService';

const makeSettings = () => ({
  plex: { ip: '203.0.113.1', machineId: 'machine-x', libraries: [] },
  save: h.save,
  load() {
    return this;
  },
  setGlobalSyncComplete: vi.fn(),
  setGlobalSyncError: vi.fn(),
});

beforeEach(() => {
  h.settings = makeSettings();
  h.order.length = 0;
  h.save.mockClear();
  vi.restoreAllMocks();
});

describe('collectionsSync.run rotation hook', () => {
  it('runs the rotation pass once, after the Plex check and before the configs sync, with a sync run id', async () => {
    vi.spyOn(rotationGroupService, 'hasEnabledGroups').mockReturnValue(true);
    vi.spyOn(rotationGroupService, 'captureSeqs').mockReturnValue({});
    const pass = vi
      .spyOn(rotationGroupService, 'runPass')
      .mockImplementation(() => {
        h.order.push('rotation');
        return { changed: [], rotated: [], saved: false };
      });

    await collectionsSync.run();

    expect(pass).toHaveBeenCalledTimes(1);
    expect(pass.mock.calls[0][0]?.syncRunId).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(h.order).toEqual(['plex', 'rotation', 'configs']);
  });

  it('with no rotation groups the pass is skipped and settings are not written', async () => {
    const pass = vi.spyOn(rotationGroupService, 'runPass');

    await collectionsSync.run();

    expect(h.order).toEqual(['plex', 'configs']);
    expect(pass).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });
});

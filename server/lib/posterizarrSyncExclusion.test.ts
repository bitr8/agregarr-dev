import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trigger: { busy: true },
  getRepository: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock('@server/lib/posterizarrTrigger', () => ({ default: mocks.trigger }));
vi.mock('@server/datasource', () => ({ getRepository: mocks.getRepository }));
vi.mock('@server/lib/settings', () => ({ getSettings: mocks.getSettings }));
vi.mock('@server/api/plexapi', () => ({ default: vi.fn() }));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@server/lib/collections/CollectionSyncProgress', () => ({
  default: {},
}));
vi.mock('@server/lib/collections/core/CollectionUtilities', () => ({
  extractErrorMessage: vi.fn(),
}));
vi.mock('@server/lib/collections/services/CollectionCleanupService', () => ({
  CollectionCleanupService: class {},
}));
vi.mock('@server/lib/collections/services/CollectionSyncService', () => ({
  collectionSyncService: {},
}));

import collectionsSync from './collectionsSync';
import overlayApplication from './overlayApplication';

describe('full sync exclusion during Posterizarr work', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collectionsSync.running = false;
    collectionsSync.pending = false;
    overlayApplication.running = false;
    overlayApplication.pending = false;
  });

  it.each([
    ['collection', collectionsSync],
    ['overlay', overlayApplication],
  ] as const)(
    'does not start a %s sync when callbacks are queued or running',
    async (_name, job) => {
      await job.run();
      expect(job.status.running).toBe(false);
      expect(job.status.pending).toBe(false);
      expect(mocks.getRepository).not.toHaveBeenCalled();
      expect(mocks.getSettings).not.toHaveBeenCalled();
    }
  );
});

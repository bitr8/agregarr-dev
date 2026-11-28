import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trigger: { busy: false },
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

describe('full collections sync re-entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collectionsSync.running = false;
    collectionsSync.pending = false;
  });

  it.each([
    ['running', { running: true, pending: false }],
    ['pending', { running: false, pending: true }],
  ] as const)('skips a second run while one is %s', async (_name, state) => {
    collectionsSync.running = state.running;
    collectionsSync.pending = state.pending;
    await collectionsSync.run();
    expect(collectionsSync.running).toBe(state.running);
    expect(collectionsSync.pending).toBe(state.pending);
    expect(mocks.getRepository).not.toHaveBeenCalled();
    expect(mocks.getSettings).not.toHaveBeenCalled();
  });

  it('releases pending when the pre-flight throws, so a later sync can start', async () => {
    const spy = vi
      .spyOn(
        collectionsSync as unknown as { runClaimed: () => Promise<void> },
        'runClaimed'
      )
      .mockImplementationOnce(async () => {
        collectionsSync.pending = true;
        throw new Error('import failed');
      });
    await expect(collectionsSync.run()).rejects.toThrow('import failed');
    expect(collectionsSync.pending).toBe(false);
    spy.mockRestore();
  });

  it('reports a guarded run as skipped', async () => {
    collectionsSync.running = true;
    await expect(collectionsSync.run()).resolves.toBe('skipped');
  });

  it('starts one more run after the current one when asked', async () => {
    const spy = vi
      .spyOn(
        collectionsSync as unknown as { runClaimed: () => Promise<void> },
        'runClaimed'
      )
      .mockResolvedValue(undefined);
    collectionsSync.requestRunAfterCurrent();
    await collectionsSync.run();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

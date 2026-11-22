import { beforeEach, describe, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() },
}));
vi.mock('@server/api/plexapi', () => ({ default: class {} }));
vi.mock('@server/lib/settings', () => ({ getSettings: () => ({}) }));
vi.mock('@server/lib/collections/CollectionSyncProgress', () => ({
  default: { setDetail: vi.fn() },
}));
vi.mock('@server/lib/collections/core/CollectionUtilities', () => ({
  extractErrorMessage: vi.fn(),
}));
vi.mock('@server/lib/placeholders/seerrIgnorePatterns', () => ({
  ensureSeerrIgnorePatterns: vi.fn(),
}));
vi.mock('@server/lib/posterizarrTrigger', () => ({ default: {} }));
vi.mock('./collections/services/CollectionCleanupService', () => ({
  CollectionCleanupService: class {},
}));
vi.mock('./collections/services/CollectionSyncService', () => ({
  collectionSyncService: {},
}));
vi.mock('@server/lib/randomizeHomeOrder', () => ({ default: { run } }));

import collectionsSync from './collectionsSync';

describe('collections sync home order step', () => {
  beforeEach(() => {
    run.mockReset();
    warn.mockClear();
  });

  it('tells randomizeHomeOrder it is running inside the sync', async () => {
    run.mockResolvedValue(undefined);
    await (
      collectionsSync as unknown as { randomizeHomeOrderStep(): Promise<void> }
    ).randomizeHomeOrderStep();
    expect(run).toHaveBeenCalledWith({ fromCollectionsSync: true });
  });

  it('does not fail the sync when randomising throws', async () => {
    run.mockRejectedValue(new Error('boom'));
    await expect(
      (
        collectionsSync as unknown as {
          randomizeHomeOrderStep(): Promise<void>;
        }
      ).randomizeHomeOrderStep()
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

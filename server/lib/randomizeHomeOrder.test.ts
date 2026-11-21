import { beforeEach, describe, expect, it, vi } from 'vitest';

const info = vi.hoisted(() => vi.fn());

vi.mock('@server/logger', () => ({
  default: { info, debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({ plex: { collectionConfigs: [], hubConfigs: [] } }),
}));
vi.mock('@server/lib/collectionsSync', () => ({
  default: { running: true },
}));

import randomizeHomeOrder from './randomizeHomeOrder';

describe('randomizeHomeOrder.run', () => {
  beforeEach(() => {
    info.mockClear();
  });

  it('runs when invoked from the collections sync that is still marked running', async () => {
    await randomizeHomeOrder.run({ fromCollectionsSync: true });
    expect(info).toHaveBeenCalledWith(
      'Starting Randomize Home Order',
      expect.anything()
    );
  });

  it('still skips the scheduled job while a collections sync is running', async () => {
    await randomizeHomeOrder.run();
    expect(info).not.toHaveBeenCalledWith(
      'Starting Randomize Home Order',
      expect.anything()
    );
  });
});

import type PlexAPI from '@server/api/plexapi';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.CONFIG_DIRECTORY = fs.mkdtempSync(
  path.join(os.tmpdir(), 'agregarr-hubsync-reactivate-')
);

const evaluateTimeRestriction = vi.hoisted(() => vi.fn());

vi.mock('@server/lib/collections/utils/TimeRestrictionUtils', () => ({
  TimeRestrictionUtils: { evaluateTimeRestriction },
}));

const allOn = {
  usersHome: true,
  serverOwnerHome: true,
  libraryRecommended: true,
};
const allOff = {
  usersHome: false,
  serverOwnerHome: false,
  libraryRecommended: false,
};

const sync = async (isActive: boolean) => {
  const { default: HubSyncService } = await import('./HubSyncService');
  const updateHubVisibility = vi.fn();
  const plexClient = { updateHubVisibility } as unknown as PlexAPI;
  const config = {
    id: 'pre-1',
    name: 'Seasonal',
    libraryId: '1',
    mediaType: 'movie',
    collectionRatingKey: '900',
    isActive,
    visibilityConfig: allOn,
    timeRestriction: {
      alwaysActive: false,
      inactiveVisibilityConfig: allOff,
    },
  };
  await (
    new HubSyncService() as unknown as {
      syncPreExistingCollections: (c: PlexAPI, cfgs: object[]) => Promise<void>;
    }
  ).syncPreExistingCollections(plexClient, [config]);
  return { visibility: updateHubVisibility.mock.calls[0][2], config };
};

describe('pre-existing collection time restriction', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reactivates when the active period starts after a hidden inactive period', async () => {
    evaluateTimeRestriction.mockReturnValue({ isActive: true, reason: 'x' });
    const { visibility, config } = await sync(false);
    expect(visibility).toEqual({
      promotedToOwnHome: true,
      promotedToSharedHome: true,
      promotedToRecommended: true,
    });
    expect(config.isActive).toBe(true);
  });

  it('hides when the active period ends', async () => {
    evaluateTimeRestriction.mockReturnValue({ isActive: false, reason: 'x' });
    const { visibility, config } = await sync(true);
    expect(visibility).toEqual({
      promotedToOwnHome: false,
      promotedToSharedHome: false,
      promotedToRecommended: false,
    });
    expect(config.isActive).toBe(false);
  });
});

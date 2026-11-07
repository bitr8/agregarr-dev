import type PlexAPI from '@server/api/plexapi';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/entity/User', () => ({ User: class {} }));
vi.mock('@server/lib/collections/utils/TemplateEngine', () => ({
  templateEngine: {},
}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const settings = {
  plex: {
    libraries: [],
    collectionConfigs: [
      {
        id: '10',
        name: 'Neon Noir',
        type: 'mdblist',
        libraryId: '4',
        targetUserId: '1001',
      },
    ],
    hubConfigs: [],
    preExistingCollectionConfigs: [],
  },
  save: vi.fn(),
};
vi.mock('@server/lib/settings', () => ({
  getSettings: () => settings,
  CollectionType: {},
}));

const syncConfigs = vi.hoisted(() =>
  vi.fn(async () => ({
    syncedConfigs: [],
    updatedPlexLabels: [],
    errors: [],
  }))
);
vi.mock('@server/lib/collections/core/CollectionUtilities', async () => ({
  ...(await vi.importActual<object>(
    '@server/lib/collections/core/CollectionUtilities'
  )),
  syncConfigsWithPlexCollections: syncConfigs,
}));

import { DiscoveryService } from './DiscoveryService';

describe('discovery relabel step', () => {
  it('hands each config targetUserId to the relabel so target-user labels survive', async () => {
    const service = new DiscoveryService();
    const internals = service as unknown as Record<string, unknown> & {
      [k: string]: (...a: unknown[]) => Promise<unknown>;
    };
    internals.cleanupOrphanedLibraryConfigs = (() => ({ removed: 0 })) as never;
    internals.discoverAllCollectionsFirst = async () => [];
    internals.resetPreExistingPromotionStatus = async () => undefined;
    internals.discoverHubsAndEnhance = async () => undefined;
    internals.promoteCollectionsThatShouldBeVisible = async () => undefined;
    internals.validateExistingCollections = async () => {
      throw new Error('stop');
    };

    await expect(
      service.discoverAllHubs(
        { getLibraries: async () => [] } as unknown as PlexAPI,
        false,
        true
      )
    ).rejects.toThrow('stop');

    const configs = (
      syncConfigs.mock.calls as unknown as unknown[][]
    )[0][1] as {
      targetUserId?: string;
    }[];
    expect(configs[0].targetUserId).toBe('1001');
  });
});

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

vi.mock('@server/routes/reorder', () => ({
  autoReorderLibrary: vi.fn(async () => undefined),
}));
vi.mock('@server/lib/collections/services/DefaultHubConfigService', () => ({
  defaultHubConfigService: {},
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

describe('enhanced pre-existing write-back', () => {
  it('keeps a visibility restored between discovery taking its copy and writing it back', async () => {
    const hidden = {
      usersHome: false,
      serverOwnerHome: false,
      libraryRecommended: false,
    };
    const restored = {
      usersHome: true,
      serverOwnerHome: true,
      libraryRecommended: false,
    };
    const config = {
      id: 'pre-1',
      collectionRatingKey: 'rk-1',
      name: 'Collection One',
      libraryId: '4',
      sortOrderHome: 0,
      visibilityConfig: hidden,
      isPromotedToHub: false,
    };
    settings.plex.preExistingCollectionConfigs = [config] as never;

    const service = new DiscoveryService();
    const internals = service as unknown as Record<string, unknown>;
    internals.cleanupOrphanedLibraryConfigs = () => ({ removed: 0 });
    internals.discoverAllCollectionsFirst = async () => [];
    internals.resetPreExistingPromotionStatus = async () => undefined;
    internals.promoteCollectionsThatShouldBeVisible = async () => undefined;
    internals.validateExistingCollections = async () => ({});
    internals.discoverHubsAndEnhance = async (...args: unknown[]) => {
      const enhanced = args[10] as unknown[];
      const live = settings.plex
        .preExistingCollectionConfigs[0] as typeof config;
      enhanced.push({ ...live, sortOrderHome: 5, isPromotedToHub: true });
      // a member restore lands while discovery is awaiting Plex
      live.visibilityConfig = restored;
      live.sortOrderHome = 3;
    };

    await service.discoverAllHubs(
      {
        getLibraries: async () => [
          { key: '4', title: 'Library Four', type: 'movie' },
        ],
      } as unknown as PlexAPI,
      true,
      true
    );

    const after = settings.plex
      .preExistingCollectionConfigs[0] as typeof config;
    expect(after.visibilityConfig).toEqual(restored);
    expect(after.sortOrderHome).toBe(3);
    expect(after.isPromotedToHub).toBe(true);
  });
});

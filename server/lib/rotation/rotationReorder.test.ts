import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

const state = vi.hoisted(() => ({ settings: undefined as unknown }));

vi.mock('@server/lib/settings', async (importOriginal) => {
  const actual = (await importOriginal()) as { getSettings: () => unknown };
  return {
    ...actual,
    getSettings: () => state.settings ?? actual.getSettings(),
  };
});

vi.mock('@server/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@server/lib/metadata/MetadataTrackingService', () => ({
  default: { getPosterLocalPath: vi.fn(async () => null) },
}));

vi.mock('@server/lib/posterStorage', () => ({
  getPosterUrl: (f: string) => `/poster/${f}`,
}));

vi.mock('@server/lib/collections/services/DefaultHubConfigService', () => {
  const svc = {
    getConfigs: () =>
      (state.settings as { plex: { hubConfigs?: unknown[] } }).plex
        .hubConfigs ?? [],
    saveExistingConfigs: (configs: unknown[]) => {
      (state.settings as { plex: { hubConfigs?: unknown[] } }).plex.hubConfigs =
        configs.map((c) => ({ ...(c as object) }));
    },
  };
  return { defaultHubConfigService: svc, default: svc };
});

vi.mock(
  '@server/lib/collections/services/PreExistingCollectionConfigService',
  () => {
    const svc = {
      getConfigs: () =>
        (
          state.settings as {
            plex: { preExistingCollectionConfigs?: unknown[] };
          }
        ).plex.preExistingCollectionConfigs ?? [],
      saveExistingConfigs: (configs: unknown[]) => {
        (
          state.settings as {
            plex: { preExistingCollectionConfigs?: unknown[] };
          }
        ).plex.preExistingCollectionConfigs = configs.map((c) => ({
          ...(c as object),
        }));
      },
    };
    return { preExistingCollectionConfigService: svc, default: svc };
  }
);

vi.mock('./rotationApply', () => ({
  rotationApply: { status: { running: false }, kick: vi.fn() },
  default: { status: { running: false }, kick: vi.fn() },
}));

import { rotationGroupService as service } from './RotationGroupService';

type Cfg = Record<string, unknown>;

const SHOWN = {
  usersHome: true,
  serverOwnerHome: true,
  libraryRecommended: false,
};

const pre = (id: string, pos: number): Cfg => ({
  id,
  collectionRatingKey: `rk-${id}`,
  name: id,
  libraryId: 'lib-1',
  libraryName: 'Library One',
  mediaType: 'movie',
  sortOrderHome: pos,
  sortOrderLibrary: 0,
  isLibraryPromoted: false,
  visibilityConfig: SHOWN,
  isActive: true,
  collectionType: 'preexisting',
});

// Home order: n1, m2, hub, m4, multi, m5, n3, n6
const makeSettings = () => ({
  plex: {
    libraries: [{ key: 'lib-1', name: 'Library One', type: 'movie' }],
    preExistingCollectionConfigs: [
      pre('n1', 1),
      pre('m2', 2),
      pre('m4', 4),
      pre('m5', 6),
      pre('n3', 7),
      pre('n6', 8),
    ],
    collectionConfigs: [
      {
        id: 'multi',
        name: 'Multi',
        libraryId: ['lib-1', 'lib-2'],
        sortOrderHome: 5,
        sortOrderLibrary: 0,
        visibilityConfig: SHOWN,
      },
    ],
    hubConfigs: [
      {
        id: 'hub',
        name: 'Hub',
        libraryId: 'lib-1',
        sortOrderHome: 3,
        sortOrderLibrary: 0,
        visibilityConfig: SHOWN,
      },
    ],
  },
  jobs: { 'plex-collections-sync': { schedule: '0 0 */3 * * *' } },
  save: vi.fn(),
});

const plex = () =>
  (state.settings as ReturnType<typeof makeSettings>).plex as unknown as {
    preExistingCollectionConfigs: Cfg[];
    collectionConfigs: Cfg[];
    hubConfigs: Cfg[];
  };

const homeRows = () =>
  [
    ...plex().preExistingCollectionConfigs,
    ...plex().collectionConfigs,
    ...plex().hubConfigs,
  ]
    .filter((c) => (c.sortOrderHome as number) > 0)
    .sort((a, b) => (a.sortOrderHome as number) - (b.sortOrderHome as number));

const groupId = () =>
  (state.settings as { plex: { rotationGroups: { id: string }[] } }).plex
    .rotationGroups[0].id;

const members = ['m2', 'm4', 'm5'].map((configId) => ({
  kind: 'preExisting' as const,
  configId,
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 14, 10, 0, 0));
  state.settings = makeSettings();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('leaving a rotation through the real reorder', () => {
  it('delete keeps other rows in order with no shared positions', async () => {
    await service.createGroup({
      name: 'Group One',
      libraryId: 'lib-1',
      enabled: true,
      slotCount: 1,
      interval: 'daily',
      order: 'sequential',
      surfaces: SHOWN,
      members,
    });
    service.rotateNow(groupId());
    await service.settlePositions(['lib-1']);
    const others = ['n1', 'hub', 'multi', 'n3', 'n6'];
    const before = homeRows()
      .map((c) => c.id as string)
      .filter((id) => others.includes(id));

    service.deleteGroup(groupId());
    await service.settlePositions(['lib-1']);

    const rows = homeRows();
    const after = rows.map((c) => c.id as string);
    expect(after.filter((id) => others.includes(id))).toEqual(before);
    expect(before).toEqual(['n1', 'hub', 'multi', 'n3', 'n6']);
    const positions = rows.map((c) => c.sortOrderHome as number);
    expect(new Set(positions).size).toBe(positions.length);
    expect(after.length).toBe(8);
    expect(
      plex().preExistingCollectionConfigs[0].visibilityConfig as Cfg
    ).toEqual(SHOWN);
  });

  it('removing the showing member puts its replacement in the slot and the removed one last', async () => {
    const base = {
      name: 'Group One',
      libraryId: 'lib-1',
      enabled: true,
      slotCount: 1,
      interval: 'daily' as const,
      order: 'sequential' as const,
      surfaces: SHOWN,
    };
    await service.createGroup({ ...base, members });
    await service.settlePositions(['lib-1']);
    const showing = homeRows().find((c) =>
      ['m2', 'm4', 'm5'].includes(c.id as string)
    );
    const slotIndex = homeRows().indexOf(showing as Cfg);
    const others = ['n1', 'hub', 'multi', 'n3', 'n6'];
    const before = homeRows()
      .map((c) => c.id as string)
      .filter((id) => others.includes(id));

    await service.updateGroup(groupId(), {
      ...base,
      members: members.filter((m) => m.configId !== showing?.id),
    });
    await service.settlePositions(['lib-1']);

    const rows = homeRows();
    const after = rows.map((c) => c.id as string);
    expect(after.filter((id) => others.includes(id))).toEqual(before);
    expect(after[after.length - 1]).toBe(showing?.id);
    expect(after[slotIndex]).not.toBe(showing?.id);
    expect(['m2', 'm4', 'm5']).toContain(after[slotIndex]);
    const positions = rows.map((c) => c.sortOrderHome as number);
    expect(new Set(positions).size).toBe(positions.length);
  });
});

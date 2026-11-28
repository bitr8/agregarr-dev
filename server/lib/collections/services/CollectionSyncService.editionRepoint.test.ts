import type PlexAPI from '@server/api/plexapi';
import { beforeEach, expect, it, vi } from 'vitest';
import { collectionSyncService } from './CollectionSyncService';

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  configs: [] as Record<string, unknown>[],
}));
const cleanup = vi.hoisted(() => vi.fn(async () => true));

vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({ plex: { collectionConfigs: state.configs } }),
}));
vi.mock('@server/datasource', () => ({
  getRepository: () => ({
    createQueryBuilder: () => ({
      where: () => ({ getMany: async () => state.rows }),
    }),
  }),
}));
vi.mock('@server/api/themoviedb', () => ({ default: class {} }));
vi.mock('@server/lib/placeholders/services/PlaceholderCleanup', () => ({
  cleanupPlaceholderForRealContent: cleanup,
  rootOf: () => '/root',
  removeGhostEntries: vi.fn(),
}));
vi.mock('@server/lib/placeholders/placeholderManager', () => ({
  resolveRecordPath: (_root: string, p: string) => '/root/' + p,
}));
vi.mock('@server/lib/placeholders/helpers/placeholderPathHelpers', () => ({
  getPlaceholderRootFolder: () => '/root',
}));

const RUN_START = '2026-11-28T00:00:00.000Z';

const plexWith = (members: string[]) =>
  ({
    getCollectionItems: vi.fn(async () => members),
    removeItemFromCollection: vi.fn(async () => undefined),
  } as unknown as PlexAPI & {
    removeItemFromCollection: ReturnType<typeof vi.fn>;
  });

beforeEach(() => {
  cleanup.mockClear();
  state.rows = [
    {
      configId: 'cfg',
      placeholderPath: 'Show {edition-Trailer}',
      plexRatingKey: '100',
      pendingRealRatingKey: '200',
      tmdbId: 1,
      mediaType: 'tv',
      title: 'Show',
    },
  ];
  state.configs = [
    {
      id: 'cfg',
      collectionRatingKey: '9',
      libraryId: '1',
      lastSyncedAt: RUN_START,
    },
  ];
});

const run = (plex: PlexAPI) =>
  collectionSyncService['processEditionRepoints'](plex, RUN_START);

it('cleans up when the edition is no longer in the collection', async () => {
  const plex = plexWith([]);
  await run(plex);
  expect(plex.removeItemFromCollection).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it('removes the edition when its config synced this run and the real show never joined', async () => {
  const plex = plexWith(['100']);
  await run(plex);
  expect(plex.removeItemFromCollection).toHaveBeenCalledWith('9', '100');
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it('defers when the config did not sync this run', async () => {
  state.configs[0].lastSyncedAt = '2026-11-27T00:00:00.000Z';
  const plex = plexWith(['100']);
  await run(plex);
  expect(plex.removeItemFromCollection).not.toHaveBeenCalled();
  expect(cleanup).not.toHaveBeenCalled();
});

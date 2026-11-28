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

const REAL = {
  type: 'show',
  Guid: [{ id: 'tmdb://1' }],
};

const plexWith = (
  members: string[] | Error | Record<string, string[] | Error>,
  real: unknown = REAL
) =>
  ({
    getCollectionItemsOrThrow: vi.fn(async (rk: string) => {
      const m =
        Array.isArray(members) || members instanceof Error
          ? members
          : members[rk];
      if (m instanceof Error) throw m;
      return m;
    }),
    getMetadata: vi.fn(async () => {
      if (real instanceof Error) throw real;
      return real;
    }),
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

it('defers when the collection read throws', async () => {
  const plex = plexWith(new Error('plex down'));
  await run(plex);
  expect(plex.removeItemFromCollection).not.toHaveBeenCalled();
  expect(cleanup).not.toHaveBeenCalled();
});

it('defers when the pending real show has the wrong tmdb id', async () => {
  const plex = plexWith([], { type: 'show', Guid: [{ id: 'tmdb://999' }] });
  await run(plex);
  expect(cleanup).not.toHaveBeenCalled();
});

it('defers when the pending real show is itself an edition', async () => {
  const plex = plexWith([], { ...REAL, editionTitle: 'Trailer' });
  await run(plex);
  expect(cleanup).not.toHaveBeenCalled();
});

it('defers when the pending real show cannot be fetched', async () => {
  const plex = plexWith([], new Error('404'));
  await run(plex);
  expect(cleanup).not.toHaveBeenCalled();
});

it('does not clean up when one of two collections defers', async () => {
  state.configs[0] = {
    id: 'cfg',
    collectionRatingKeys: ['9', '10'],
    libraryId: '1',
    lastSyncedAt: '2026-11-27T00:00:00.000Z',
  };
  const plex = plexWith({ '9': ['100', '200'], '10': ['100'] });
  await run(plex);
  expect(plex.removeItemFromCollection).toHaveBeenCalledTimes(1);
  expect(cleanup).not.toHaveBeenCalled();
});

it('skips the re-point pass when the sync was cancelled', async () => {
  const svc = collectionSyncService as unknown as { cancelled: boolean };
  svc.cancelled = true;
  const plex = plexWith(['100']);
  try {
    await run(plex);
  } finally {
    svc.cancelled = false;
  }
  expect(plex.getCollectionItemsOrThrow).not.toHaveBeenCalled();
  expect(cleanup).not.toHaveBeenCalled();
});

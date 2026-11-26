import type PlexAPI from '@server/api/plexapi';
import type { CollectionConfig } from '@server/lib/settings';
import { expect, it, vi } from 'vitest';
import { collectionSyncService } from './CollectionSyncService';

const libraries = vi.hoisted(() => [
  { key: '1', type: 'show', title: 'First library' },
  { key: '2', type: 'show', title: 'Second library' },
]);

vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({ plex: { libraries } }),
}));
vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/api/themoviedb', () => ({ default: class {} }));
vi.mock('@server/lib/placeholders/helpers/placeholderPathHelpers', () => ({
  getPlaceholderRootFolder: (id: string) => '/fixtures/' + id,
}));
vi.mock('@server/lib/placeholders/placeholderManager', () => ({
  upgradeMarkerFile: vi.fn(),
  scanForMarkerFiles: async (root: string) => [
    { title: root, tmdbId: 10, tvdbId: 20, placeholderPath: root + '/show' },
  ],
}));
vi.mock('@server/lib/placeholders/services/PlaceholderContextService', () => ({
  placeholderContextService: {
    batchCheckDownloadStatus: vi.fn(async () => ({ showsByTvdbId: new Map() })),
  },
}));

it('skips Tier 1 discovery for a library whose live Plex retry fails and continues with the next library', async () => {
  const getLibraryContents = vi.fn().mockRejectedValue(new Error('offline'));
  const plex = {
    getLibraries: async () => libraries,
    getLibraryContents,
  } as unknown as PlexAPI;
  const configs = libraries.map(
    ({ key }) =>
      ({
        libraryId: key,
        createPlaceholdersForMissing: true,
      } as CollectionConfig)
  );
  const result = await collectionSyncService['prefetchPlaceholderDiscovery'](
    plex,
    configs,
    { '2': [] }
  );

  expect(result.tv.map(({ marker }) => marker.placeholderPath)).toEqual([
    '/fixtures/2/show',
  ]);
  expect(getLibraryContents).toHaveBeenCalledTimes(1);
  expect(getLibraryContents.mock.calls[0][0]).toBe('1');
});

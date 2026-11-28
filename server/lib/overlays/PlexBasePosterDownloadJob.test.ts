import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  downloadAll: vi.fn(),
}));

vi.mock('@server/api/plexapi', () => ({ default: class {} }));
vi.mock('@server/datasource', () => ({
  getRepository: () => ({
    find: async () => [{ libraryId: '1', libraryName: 'Movies' }],
  }),
}));
vi.mock('@server/entity/OverlayLibraryConfig', () => ({
  OverlayLibraryConfig: class {},
}));
vi.mock('@server/lib/collections/core/CollectionUtilities', () => ({
  getAdminUser: async () => ({ plexToken: 't' }),
}));
vi.mock('./PlexBasePosterManager', () => ({
  plexBasePosterManager: {
    moveOrphanedPosters: async () => 0,
    downloadAllBasePosterForLibrary: mocks.downloadAll,
  },
}));

import { plexBasePosterDownloadJob } from './PlexBasePosterDownloadJob';

describe('PlexBasePosterDownloadJob status', () => {
  it('reports skipped overlaid posters in the overall progress', async () => {
    mocks.downloadAll.mockImplementation(
      async (
        _api: unknown,
        _lib: string,
        onProgress: (c: number, t: number, f: number, s: number) => void
      ) => {
        onProgress(2, 2, 0, 1);
        return { success: 1, failed: 0, skippedOverlaid: 1 };
      }
    );

    await plexBasePosterDownloadJob.run();

    const { overallProgress, libraries } = plexBasePosterDownloadJob.status;
    expect(overallProgress.skipped).toBe(1);
    expect(libraries['1'].skipped).toBe(1);
  });
});

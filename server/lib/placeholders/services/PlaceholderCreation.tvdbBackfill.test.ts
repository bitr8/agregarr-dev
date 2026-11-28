import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  batch: vi.fn(),
  filterUnmatched: vi
    .fn<(lib: string, items: unknown[]) => Promise<unknown[]>>()
    .mockResolvedValue([]),
}));

vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@server/lib/settings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSettings: () => ({
    main: { placeholderEditions: false },
    plex: { libraries: [] },
  }),
}));

vi.mock('@server/lib/plexVersion', () => ({
  ensurePlexVersion: async () => undefined,
  plexVersionKnown: () => true,
}));

vi.mock('@server/lib/collections/sources/comingsoon/comingSoonFetch', () => ({
  enrichWithTMDBReleaseDates: async (
    items: { mediaType: string; tvdbId?: number; airDate?: string }[]
  ) => {
    for (const item of items) {
      item.airDate = '2020-01-01';
      if (item.mediaType === 'tv' && !item.tvdbId) {
        item.tvdbId = 4242;
      }
    }
  },
}));

vi.mock('@server/lib/placeholders/services/PlaceholderContextService', () => ({
  placeholderContextService: { batchCheckDownloadStatus: mocks.batch },
}));

vi.mock('./unmatchedPlaceholderCache', () => ({
  filterRecentlyUnmatched: mocks.filterUnmatched,
  clearUnmatchedPlaceholder: vi.fn(),
  recordUnmatchedPlaceholder: vi.fn(),
}));

import type { MissingItem } from '@server/lib/collections/core/types';
import { processPlaceholdersForMissingItems } from './PlaceholderCreation';

const show = (): MissingItem =>
  ({
    tmdbId: 100,
    mediaType: 'tv',
    title: 'Some Show',
    year: 2020,
    originalPosition: 1,
  } as MissingItem);

const config = {
  type: 'tmdb',
  name: 'c',
  libraryId: '1',
  createPlaceholdersForMissing: true,
} as never;

const run = (items: MissingItem[]) =>
  processPlaceholdersForMissingItems(items, config, {} as never);

const sonarr = (downloaded: boolean) =>
  mocks.batch.mockResolvedValue({
    moviesByTmdbId: new Map(),
    showsByTvdbId: new Map([
      [4242, { downloaded, folderName: 'Some Show (2020)' }],
    ]),
  });

beforeEach(() => {
  mocks.batch.mockReset();
  mocks.filterUnmatched.mockClear();
});

describe('TV items whose tvdbId is only known after TMDB enrichment', () => {
  it('skips a show already downloaded in Sonarr', async () => {
    sonarr(true);
    await run([show()]);

    expect(mocks.batch.mock.calls[0][0]).toEqual([
      { tmdbId: 100, tvdbId: 4242, mediaType: 'tv' },
    ]);
    expect(mocks.filterUnmatched).not.toHaveBeenCalled();
  });

  it('passes the backfilled tvdbId to the items the Sonarr folder map is built from', async () => {
    sonarr(false);
    await run([show()]);

    expect(mocks.filterUnmatched).toHaveBeenCalledTimes(1);
    const items = mocks.filterUnmatched.mock.calls[0][1] as MissingItem[];
    expect(items.map((i) => i.tvdbId)).toEqual([4242]);
  });

  it('leaves the caller array untouched', async () => {
    sonarr(false);
    const input = [show()];
    await run(input);
    expect(input[0].tvdbId).toBeUndefined();
  });
});

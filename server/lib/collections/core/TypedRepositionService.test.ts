import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Covers the write path - the pure rank arithmetic is tested in
 * CollectionUtilities.test.ts, but nothing reached the part that persists the
 * result and marks the peers it moved as needing sync.
 */

const markCollectionModified = vi.fn();
const save = vi.fn();

const settings = {
  plex: {
    collectionConfigs: [] as {
      id: string;
      sortOrderLibrary?: number;
      isLibraryPromoted?: boolean;
      libraryId?: string | string[];
    }[],
    preExistingCollectionConfigs: [] as {
      id: string;
      sortOrderLibrary?: number;
      isLibraryPromoted?: boolean;
      libraryId?: string;
    }[],
    hubConfigs: [] as {
      id: string;
      sortOrderLibrary?: number;
      isLibraryPromoted?: boolean;
      libraryId?: string;
    }[],
  },
  save,
  markCollectionModified,
};

vi.mock('@server/lib/settings', () => ({
  getSettings: () => settings,
}));

vi.mock(
  '@server/lib/collections/services/PreExistingCollectionConfigService',
  () => ({
    preExistingCollectionConfigService: {
      getConfigs: () => settings.plex.preExistingCollectionConfigs,
      saveExistingConfigs: vi.fn(),
    },
  })
);

vi.mock('@server/lib/collections/services/DefaultHubConfigService', () => ({
  defaultHubConfigService: {
    getConfigs: () => settings.plex.hubConfigs,
    saveExistingConfigs: vi.fn(),
  },
}));

vi.mock('@server/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('compactAndApplyPromotedRanks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.plex.collectionConfigs = [];
    settings.plex.preExistingCollectionConfigs = [];
    settings.plex.hubConfigs = [];
  });

  it('closes a gap and marks only the collections it moved', async () => {
    // 1, 3, 4 -> 1, 2, 3: the two above the gap move, the one below does not.
    settings.plex.collectionConfigs = [
      {
        id: 'a',
        sortOrderLibrary: 1,
        isLibraryPromoted: true,
        libraryId: '10',
      },
      {
        id: 'b',
        sortOrderLibrary: 3,
        isLibraryPromoted: true,
        libraryId: '10',
      },
      {
        id: 'c',
        sortOrderLibrary: 4,
        isLibraryPromoted: true,
        libraryId: '10',
      },
    ];

    const { compactAndApplyPromotedRanks } = await import(
      './TypedRepositionService'
    );
    await compactAndApplyPromotedRanks('10');

    const ranks = Object.fromEntries(
      settings.plex.collectionConfigs.map((c) => [c.id, c.sortOrderLibrary])
    );
    expect(ranks).toEqual({ a: 1, b: 2, c: 3 });

    expect(save).toHaveBeenCalled();
    const marked = markCollectionModified.mock.calls.map((call) => call[0]);
    expect(marked).toContain('b');
    expect(marked).toContain('c');
    expect(marked).not.toContain('a');
  });

  it('writes nothing when the ranks are already a clean sequence', async () => {
    settings.plex.collectionConfigs = [
      {
        id: 'a',
        sortOrderLibrary: 1,
        isLibraryPromoted: true,
        libraryId: '10',
      },
      {
        id: 'b',
        sortOrderLibrary: 2,
        isLibraryPromoted: true,
        libraryId: '10',
      },
    ];

    const { compactAndApplyPromotedRanks } = await import(
      './TypedRepositionService'
    );
    await compactAndApplyPromotedRanks('10');

    expect(save).not.toHaveBeenCalled();
    expect(markCollectionModified).not.toHaveBeenCalled();
  });
});

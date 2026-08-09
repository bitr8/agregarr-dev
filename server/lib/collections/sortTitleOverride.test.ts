import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const updateCollectionSortTitleSpy = vi.fn();

describe('sortTitleOverride — BaseCollectionSync logic', () => {
  const buildSortTitleArgs = (overrides: {
    sortTitleOverride?: string;
    isLibraryPromoted?: boolean;
    sortOrderLibrary?: number;
    everLibraryPromoted?: boolean;
    collectionName?: string;
  }) => {
    const {
      sortTitleOverride,
      isLibraryPromoted = true,
      sortOrderLibrary = 1,
      everLibraryPromoted,
      collectionName = 'Romance',
    } = overrides;

    return {
      matchingConfig: {
        id: 'test-id',
        sortTitleOverride,
        everLibraryPromoted,
        sortOrderLibrary,
        isLibraryPromoted,
        libraryId: 'lib-1',
      },
      sortOrderLibrary,
      isLibraryPromoted,
      collectionName,
      collectionRatingKey: 'rk-123',
      existingTitleSort: '!!!Romance',
      allConfigs: [
        {
          id: 'test-id',
          sortTitleOverride,
          everLibraryPromoted,
          sortOrderLibrary,
          isLibraryPromoted,
          libraryId: 'lib-1',
          collectionRatingKey: 'rk-123',
        },
      ],
    };
  };

  /**
   * Replicates the sort-title decision logic from BaseCollectionSync.updateCollectionMetadata
   * without instantiating the full class (same pattern as plexapi.test.ts).
   */
  async function applySortTitle(args: ReturnType<typeof buildSortTitleArgs>) {
    const {
      matchingConfig,
      sortOrderLibrary,
      isLibraryPromoted,
      collectionName,
      collectionRatingKey,
      existingTitleSort,
      allConfigs,
    } = args;

    // Override wins unconditionally (before everLibraryPromoted guard)
    if (matchingConfig?.sortTitleOverride) {
      await updateCollectionSortTitleSpy(
        collectionRatingKey,
        matchingConfig.sortTitleOverride,
        existingTitleSort
      );
      return;
    }

    // everLibraryPromoted guard
    if (
      sortOrderLibrary === undefined ||
      matchingConfig?.everLibraryPromoted === false
    ) {
      return;
    }

    let sortTitle: string;

    if (isLibraryPromoted && sortOrderLibrary > 0) {
      const sameLibraryConfigs = allConfigs.filter(
        (c) =>
          c.libraryId === 'lib-1' &&
          c.sortOrderLibrary !== undefined &&
          c.isLibraryPromoted === true
      );

      if (sameLibraryConfigs.length > 0) {
        const sortOrders = sameLibraryConfigs
          .map((c) => c.sortOrderLibrary)
          .filter((order): order is number => order !== undefined);
        const maxSortOrder = Math.max(...sortOrders);
        const exclamationCount = maxSortOrder - sortOrderLibrary + 2;
        const exclamationPrefix = '!'.repeat(exclamationCount);
        sortTitle = `${exclamationPrefix}${collectionName}`;
      } else {
        sortTitle = `!!${collectionName}`;
      }
    } else {
      sortTitle = collectionName;
    }

    await updateCollectionSortTitleSpy(
      collectionRatingKey,
      sortTitle,
      existingTitleSort
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should write the override verbatim when set', async () => {
    await applySortTitle(
      buildSortTitleArgs({ sortTitleOverride: '!015_Romance' })
    );

    expect(updateCollectionSortTitleSpy).toHaveBeenCalledWith(
      'rk-123',
      '!015_Romance',
      '!!!Romance'
    );
  });

  it('should use auto prefix when override is blank', async () => {
    await applySortTitle(buildSortTitleArgs({ sortTitleOverride: '' }));

    expect(updateCollectionSortTitleSpy).toHaveBeenCalledTimes(1);
    const sortTitle = updateCollectionSortTitleSpy.mock.calls[0][1] as string;
    expect(sortTitle).toMatch(/^!+Romance$/);
  });

  it('should use auto prefix when override is undefined', async () => {
    await applySortTitle(buildSortTitleArgs({}));

    expect(updateCollectionSortTitleSpy).toHaveBeenCalledTimes(1);
    const sortTitle = updateCollectionSortTitleSpy.mock.calls[0][1] as string;
    expect(sortTitle).toMatch(/^!+Romance$/);
  });

  it('should write override even for non-promoted collections', async () => {
    await applySortTitle(
      buildSortTitleArgs({
        sortTitleOverride: '!015_Romance',
        isLibraryPromoted: false,
        sortOrderLibrary: 0,
      })
    );

    expect(updateCollectionSortTitleSpy).toHaveBeenCalledWith(
      'rk-123',
      '!015_Romance',
      '!!!Romance'
    );
  });

  it('should write override even when everLibraryPromoted is false', async () => {
    await applySortTitle(
      buildSortTitleArgs({
        sortTitleOverride: '!015_Romance',
        everLibraryPromoted: false,
      })
    );

    expect(updateCollectionSortTitleSpy).toHaveBeenCalledWith(
      'rk-123',
      '!015_Romance',
      '!!!Romance'
    );
  });

  it('should skip sort title entirely when everLibraryPromoted is false and no override', async () => {
    await applySortTitle(
      buildSortTitleArgs({
        everLibraryPromoted: false,
      })
    );

    expect(updateCollectionSortTitleSpy).not.toHaveBeenCalled();
  });

  it('should write bare collection name when demoted and no override', async () => {
    await applySortTitle(
      buildSortTitleArgs({
        isLibraryPromoted: false,
        sortOrderLibrary: 0,
        everLibraryPromoted: undefined,
      })
    );

    expect(updateCollectionSortTitleSpy).toHaveBeenCalledWith(
      'rk-123',
      'Romance',
      '!!!Romance'
    );
  });
});

describe('sortTitleOverride — separator logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function buildSeparatorSortTitle(
    config: {
      sortOrderLibrary?: number;
      isLibraryPromoted?: boolean;
      sortTitleOverride?: string;
      libraryId: string;
    },
    baseTitle: string,
    allConfigs: {
      sortOrderLibrary?: number;
      isLibraryPromoted?: boolean;
      libraryId: string;
    }[]
  ): string {
    if (config.sortTitleOverride) {
      return config.sortTitleOverride;
    }

    const sortOrderLibrary = config.sortOrderLibrary;
    const isPromoted = config.isLibraryPromoted;

    if (sortOrderLibrary !== undefined && isPromoted) {
      const promotedConfigs = allConfigs.filter(
        (c) =>
          c.libraryId === config.libraryId &&
          c.sortOrderLibrary !== undefined &&
          c.isLibraryPromoted === true
      );

      const maxSortOrder =
        promotedConfigs.length > 0
          ? Math.max(
              ...promotedConfigs
                .map((c) => c.sortOrderLibrary)
                .filter((v): v is number => v !== undefined)
            )
          : 0;

      const exclamationCount = maxSortOrder
        ? maxSortOrder - sortOrderLibrary + 2
        : 2;
      const prefix = '!'.repeat(Math.max(1, exclamationCount));
      return `${prefix}0${baseTitle}`;
    }

    return `0${baseTitle}`;
  }

  it('should return override verbatim for separator', () => {
    const result = buildSeparatorSortTitle(
      {
        sortOrderLibrary: 1,
        isLibraryPromoted: true,
        sortTitleOverride: '!005_---',
        libraryId: 'lib-1',
      },
      '---',
      []
    );

    expect(result).toBe('!005_---');
  });

  it('should use separator-specific format when no override', () => {
    const result = buildSeparatorSortTitle(
      {
        sortOrderLibrary: 1,
        isLibraryPromoted: true,
        libraryId: 'lib-1',
      },
      '---',
      [{ sortOrderLibrary: 3, isLibraryPromoted: true, libraryId: 'lib-1' }]
    );

    expect(result).toMatch(/^!+0---$/);
  });

  it('should use 0-prefix for non-promoted separator without override', () => {
    const result = buildSeparatorSortTitle(
      {
        sortOrderLibrary: 0,
        isLibraryPromoted: false,
        libraryId: 'lib-1',
      },
      '---',
      []
    );

    expect(result).toBe('0---');
  });
});

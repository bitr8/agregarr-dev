import type PlexAPI from '@server/api/plexapi';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.CONFIG_DIRECTORY = fs.mkdtempSync(
  path.join(os.tmpdir(), 'agregarr-hubsync-')
);

const base = {
  libraryId: '1',
  isLibraryPromoted: false,
  sortOrderLibrary: 0,
  everLibraryPromoted: false,
};

describe('syncPreExistingCollectionSortTitles', () => {
  const run = async (configs: object[]) => {
    const { getSettings } = await import('@server/lib/settings');
    const settings = getSettings();
    settings.plex.sortTitleArticleHandling = 'off';
    settings.plex.preExistingCollectionConfigs = configs as never;
    const updateCollectionSortTitle = vi.fn().mockResolvedValue(undefined);
    const { default: HubSyncService } = await import('./HubSyncService');
    await new HubSyncService().syncPreExistingCollectionSortTitles({
      updateCollectionSortTitle,
    } as unknown as PlexAPI);
    const byId = (id: string) =>
      settings.plex.preExistingCollectionConfigs?.find((c) => c.id === id);
    return { updateCollectionSortTitle, byId };
  };

  beforeEach(() => vi.clearAllMocks());

  it('clears a reset request on every path that skips the write', async () => {
    const { byId } = await run([
      {
        ...base,
        id: 'no-key',
        name: 'A',
        sortTitleResetRequested: true,
      },
      {
        ...base,
        id: 'excluded',
        name: 'B',
        collectionRatingKey: '2',
        excludeFromOrdering: true,
        sortTitleResetRequested: true,
      },
      {
        ...base,
        id: 'override',
        name: 'C',
        collectionRatingKey: '3',
        sortTitleOverride: 'ZZZ_C',
        sortTitleResetRequested: true,
      },
    ]);
    expect(byId('no-key')?.sortTitleResetRequested).toBe(false);
    expect(byId('excluded')?.sortTitleResetRequested).toBe(false);
    expect(byId('override')?.sortTitleResetRequested).toBe(false);
  });

  it('leaves a never-promoted collection alone while the setting is off', async () => {
    const { updateCollectionSortTitle } = await run([
      {
        ...base,
        id: 'promoted-flag',
        name: 'D',
        collectionRatingKey: '4',
        isLibraryPromoted: true,
        sortOrderLibrary: 5,
        titleSort: 'Hand Set',
      },
    ]);
    expect(updateCollectionSortTitle).not.toHaveBeenCalled();
  });
});

describe('" Collection" suffix rename', () => {
  const run = async (
    configs: object[],
    options: {
      onlyConfigId?: string;
      updateCollectionTitle?: ReturnType<typeof vi.fn>;
    } = {}
  ) => {
    const { getSettings } = await import('@server/lib/settings');
    const settings = getSettings();
    settings.plex.sortTitleArticleHandling = 'off';
    settings.plex.collectionConfigs = [];
    settings.plex.preExistingCollectionConfigs = configs as never;
    const updateCollectionSortTitle = vi.fn().mockResolvedValue(undefined);
    const updateCollectionTitle =
      options.updateCollectionTitle ?? vi.fn().mockResolvedValue(undefined);
    const { default: HubSyncService } = await import('./HubSyncService');
    await new HubSyncService().syncPreExistingCollectionSortTitles(
      {
        updateCollectionSortTitle,
        updateCollectionTitle,
      } as unknown as PlexAPI,
      options.onlyConfigId
    );
    const byId = (id: string) =>
      settings.plex.preExistingCollectionConfigs?.find((c) => c.id === id);
    return { updateCollectionSortTitle, updateCollectionTitle, byId };
  };

  beforeEach(() => vi.clearAllMocks());

  it('strips the suffix in Plex and in the stored name, and the sort title follows', async () => {
    const { updateCollectionTitle, updateCollectionSortTitle, byId } =
      await run([
        {
          ...base,
          id: 'matrix',
          name: 'The Matrix Collection',
          collectionRatingKey: '10',
          collectionSuffixMode: 'strip',
        },
      ]);
    expect(updateCollectionTitle).toHaveBeenCalledWith(
      '10',
      'The Matrix',
      '1',
      'The Matrix Collection'
    );
    expect(byId('matrix')?.name).toBe('The Matrix');
    expect(updateCollectionSortTitle).toHaveBeenCalledWith(
      '10',
      'The Matrix',
      'The Matrix Collection'
    );
  });

  it('carries a sort title that was just the old name over to the new one', async () => {
    const { updateCollectionSortTitle } = await run([
      {
        ...base,
        id: 'alien',
        name: 'Alien',
        collectionRatingKey: '11',
        titleSort: 'Alien',
        collectionSuffixMode: 'add',
      },
    ]);
    expect(updateCollectionSortTitle).toHaveBeenCalledWith(
      '11',
      'Alien Collection',
      'Alien'
    );
  });

  it('renames but keeps a hand-set sort title', async () => {
    const { updateCollectionTitle, updateCollectionSortTitle } = await run([
      {
        ...base,
        id: 'hand',
        name: 'Saw Collection',
        collectionRatingKey: '12',
        titleSort: 'ZZZ Saw',
        collectionSuffixMode: 'strip',
      },
    ]);
    expect(updateCollectionTitle).toHaveBeenCalled();
    expect(updateCollectionSortTitle).not.toHaveBeenCalled();
  });

  it('renames a collection excluded from ordering without touching its sort title', async () => {
    const { updateCollectionTitle, updateCollectionSortTitle } = await run([
      {
        ...base,
        id: 'excluded',
        name: 'Halloween',
        collectionRatingKey: '13',
        excludeFromOrdering: true,
        collectionSuffixMode: 'add',
      },
    ]);
    expect(updateCollectionTitle).toHaveBeenCalledWith(
      '13',
      'Halloween Collection',
      '1',
      'Halloween'
    );
    expect(updateCollectionSortTitle).not.toHaveBeenCalled();
  });

  it('skips a rename onto a name already used in the same library', async () => {
    const { updateCollectionTitle, byId } = await run([
      { ...base, id: 'taken', name: 'Scream', collectionRatingKey: '14' },
      {
        ...base,
        id: 'blocked',
        name: 'Scream Collection',
        collectionRatingKey: '15',
        collectionSuffixMode: 'strip',
      },
      {
        ...base,
        id: 'other-library',
        libraryId: '2',
        name: 'Scream Collection',
        collectionRatingKey: '16',
        collectionSuffixMode: 'strip',
      },
    ]);
    expect(byId('blocked')?.name).toBe('Scream Collection');
    expect(updateCollectionTitle).toHaveBeenCalledTimes(1);
    expect(byId('other-library')?.name).toBe('Scream');
    expect(byId('blocked')?.collectionSuffixRenameFailed).toBe(true);
    expect(byId('other-library')?.collectionSuffixRenameFailed).toBeFalsy();
  });

  it('keeps the old name and carries on when Plex refuses the rename', async () => {
    const updateCollectionTitle = vi
      .fn()
      .mockRejectedValueOnce(new Error('Request failed with status code 409'))
      .mockResolvedValue(undefined);
    const { byId } = await run(
      [
        {
          ...base,
          id: 'refused',
          name: 'Rocky Collection',
          collectionRatingKey: '17',
          collectionSuffixMode: 'strip',
        },
        {
          ...base,
          id: 'next',
          name: 'Creed Collection',
          collectionRatingKey: '18',
          collectionSuffixMode: 'strip',
        },
      ],
      { updateCollectionTitle }
    );
    expect(byId('refused')?.name).toBe('Rocky Collection');
    expect(byId('refused')?.collectionSuffixRenameFailed).toBe(true);
    expect(byId('next')?.name).toBe('Creed');
  });

  it('clears the failed flag once the rename succeeds or nothing is left to rename', async () => {
    const { byId } = await run([
      {
        ...base,
        id: 'retry',
        name: 'Heat Collection',
        collectionRatingKey: '30',
        collectionSuffixMode: 'strip',
        collectionSuffixRenameFailed: true,
      },
      {
        ...base,
        id: 'switched-off',
        name: 'Ronin Collection',
        collectionRatingKey: '31',
        collectionSuffixMode: 'leave',
        collectionSuffixRenameFailed: true,
      },
    ]);
    expect(byId('retry')?.name).toBe('Heat');
    expect(byId('retry')?.collectionSuffixRenameFailed).toBe(false);
    expect(byId('switched-off')?.collectionSuffixRenameFailed).toBe(false);
  });

  it('only touches the requested collection on an individual sync', async () => {
    const { updateCollectionTitle, byId } = await run(
      [
        {
          ...base,
          id: 'one',
          name: 'Shrek Collection',
          collectionRatingKey: '19',
          collectionSuffixMode: 'strip',
        },
        {
          ...base,
          id: 'two',
          name: 'Cars Collection',
          collectionRatingKey: '20',
          collectionSuffixMode: 'strip',
        },
      ],
      { onlyConfigId: 'two' }
    );
    expect(updateCollectionTitle).toHaveBeenCalledTimes(1);
    expect(byId('one')?.name).toBe('Shrek Collection');
    expect(byId('two')?.name).toBe('Cars');
  });
});

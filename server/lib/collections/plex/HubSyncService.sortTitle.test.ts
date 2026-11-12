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

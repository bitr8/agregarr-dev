import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  access: vi.fn(async () => {
    throw new Error('ENOENT');
  }),
  writeFile: vi.fn<(path: string, data: Buffer) => Promise<void>>(),
}));

vi.mock('fs/promises', () => ({ default: fsMock }));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    plex: { ip: '127.0.0.1', port: 32400, useSsl: false },
  }),
}));

import type PlexAPI from '@server/api/plexapi';
import { localPosterFolderService } from './LocalPosterFolderService';

function plexApi(): PlexAPI {
  return {
    plexToken: 't',
    getLibraryContents: vi.fn().mockResolvedValue({
      items: [
        { ratingKey: '1', title: 'Overlaid', Guid: [{ id: 'tmdb://1' }] },
        { ratingKey: '2', title: 'Clean', Guid: [{ id: 'tmdb://2' }] },
      ],
      totalSize: 2,
    }),
    getCurrentPosterUrl: vi
      .fn()
      .mockImplementation(
        async (rk: string) => `/library/metadata/${rk}/thumb/1`
      ),
  } as unknown as PlexAPI;
}

describe('populateFromPlexForLibrary overlay guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not save overlaid Plex posters as local posters and reports them', async () => {
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => ({
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
      data: url.includes('/1/')
        ? Buffer.from('jpeg overlay applied by Agregarr trailer')
        : Buffer.from('plain poster bytes'),
    }));

    const stats = await localPosterFolderService.populateFromPlexForLibrary(
      plexApi(),
      '1',
      'Movies'
    );

    expect(stats).toEqual({
      downloaded: 1,
      skipped: 0,
      skippedOverlaid: 1,
      failed: 0,
    });
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
    expect(String(fsMock.writeFile.mock.calls[0][0])).toContain('tmdb-2');
    expect(
      localPosterFolderService.status.overallProgress.skippedOverlaid
    ).toBe(1);
  });
});

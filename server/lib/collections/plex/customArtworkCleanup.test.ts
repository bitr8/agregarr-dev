import type * as CleanupModule from '@server/lib/collections/plex/customArtworkCleanup';
import { createHash } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'artwork-cleanup-'));
writeFileSync(join(dir, 'wall.jpeg'), 'wallpaper bytes');
writeFileSync(join(dir, 'theme.mp3'), 'theme bytes');
const sha = (s: string) => createHash('sha1').update(s).digest('hex');
const WALL_SHA = sha('wallpaper bytes');
const THEME_SHA = sha('theme bytes');

const applied: Record<string, string | null> = {};
const cleared: string[] = [];

vi.mock('@server/lib/wallpaperStorage', () => ({
  getWallpaperPath: (f: string) => join(dir, f),
}));
vi.mock('@server/lib/themeStorage', () => ({
  getThemePath: (f: string) => join(dir, f),
}));
vi.mock('@server/lib/metadata/MetadataTrackingService', () => ({
  default: {
    getAppliedArtworkFilename: async (_rk: string, kind: string) =>
      applied[kind] ?? null,
    clearArtworkRecord: async (_rk: string, kind: string) => {
      cleared.push(kind);
    },
  },
}));
vi.mock('@server/logger', () => ({ default: { warn: vi.fn() } }));

type Cleanup = typeof CleanupModule.clearRemovedCustomArtwork;
let clearRemovedCustomArtwork: Cleanup;

const plex = (selected: { art?: string | null; theme?: string | null }) => ({
  getSelectedUploadSha: vi.fn(
    async (_rk: string, kind: 'art' | 'theme') => selected[kind] ?? null
  ),
  deleteArtwork: vi.fn(async () => undefined),
});

type Client = Parameters<Cleanup>[0];

describe('clearRemovedCustomArtwork', () => {
  beforeAll(async () => {
    ({ clearRemovedCustomArtwork } = await import(
      '@server/lib/collections/plex/customArtworkCleanup'
    ));
  });

  beforeEach(() => {
    applied.art = 'wall.jpeg';
    applied.theme = 'theme.mp3';
    cleared.length = 0;
  });

  it('removes the wallpaper and theme Agregarr applied once they are switched off', async () => {
    const client = plex({ art: WALL_SHA, theme: THEME_SHA });
    await clearRemovedCustomArtwork(
      client as unknown as Client,
      '42',
      {
        enableCustomWallpaper: false,
        customWallpaper: { '4': 'wall.jpeg' },
        enableCustomTheme: false,
        customTheme: { '4': 'theme.mp3' },
      },
      '4'
    );
    expect(client.deleteArtwork).toHaveBeenCalledWith('42', 'art');
    expect(client.deleteArtwork).toHaveBeenCalledWith('42', 'theme');
    expect(cleared).toEqual(['art', 'theme']);
  });

  it('removes them when the file is removed but the box is still ticked', async () => {
    const client = plex({ art: WALL_SHA, theme: THEME_SHA });
    await clearRemovedCustomArtwork(
      client as unknown as Client,
      '42',
      {
        enableCustomWallpaper: true,
        customWallpaper: {},
        enableCustomTheme: true,
        customTheme: '',
      },
      '4'
    );
    expect(client.deleteArtwork).toHaveBeenCalledTimes(2);
  });

  it('leaves artwork chosen in Plex since, and stops tracking it', async () => {
    const client = plex({ art: sha('picked in Plex'), theme: null });
    await clearRemovedCustomArtwork(
      client as unknown as Client,
      '42',
      {
        enableCustomWallpaper: false,
        enableCustomTheme: false,
      },
      '4'
    );
    expect(client.deleteArtwork).not.toHaveBeenCalled();
    expect(cleared).toEqual(['art', 'theme']);
  });

  it('does nothing while the wallpaper and theme are still wanted', async () => {
    const client = plex({ art: WALL_SHA, theme: THEME_SHA });
    await clearRemovedCustomArtwork(
      client as unknown as Client,
      '42',
      {
        enableCustomWallpaper: true,
        customWallpaper: { '4': 'wall.jpeg' },
        enableCustomTheme: true,
        customTheme: 'theme.mp3',
      },
      '4'
    );
    expect(client.getSelectedUploadSha).not.toHaveBeenCalled();
    expect(client.deleteArtwork).not.toHaveBeenCalled();
  });

  it('does nothing when Agregarr never applied one', async () => {
    applied.art = null;
    applied.theme = null;
    const client = plex({ art: WALL_SHA, theme: THEME_SHA });
    await clearRemovedCustomArtwork(client as unknown as Client, '42', {}, '4');
    expect(client.deleteArtwork).not.toHaveBeenCalled();
    expect(cleared).toEqual([]);
  });
});

import logger from '@server/logger';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let dir: string;
let settingsPath: string;
let backupPath: string;

const saved = JSON.stringify({
  main: { apiKey: 'kept' },
  plex: { collectionConfigs: [{ id: 'a' }, { id: 'b' }] },
});

const loadSettings = async () => {
  vi.resetModules();
  const { default: Settings } = await import('./settings');
  return new Settings().load();
};

type WithCollections = { plex: { collectionConfigs?: { id: string }[] } };

const collectionIds = (settings: unknown) =>
  ((settings as WithCollections).plex.collectionConfigs ?? []).map((c) => c.id);

const setCollections = (settings: unknown, ids: string[]) => {
  (settings as WithCollections).plex.collectionConfigs = ids.map((id) => ({
    id,
  }));
};

const fileCollectionIds = (file: string) =>
  collectionIds(JSON.parse(fs.readFileSync(file, 'utf-8')));

const errno = (code: string) => Object.assign(new Error(code), { code });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agregarr-settings-'));
  settingsPath = path.join(dir, 'settings.json');
  backupPath = `${settingsPath}.last-good`;
  vi.stubEnv('CONFIG_DIRECTORY', dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Settings.save', () => {
  it('leaves the previous settings.json in place when a write is interrupted', async () => {
    fs.writeFileSync(settingsPath, saved);
    const settings = await loadSettings();
    // Truncate-then-fail is what a stop between open and write looks like
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file) => {
      if (typeof file === 'number') fs.ftruncateSync(file, 0);
      else fs.truncateSync(file as string, 0);
      throw new Error('interrupted');
    });

    expect(() => settings.save()).toThrow('interrupted');
    expect(fileCollectionIds(settingsPath)).toEqual(['a', 'b']);
  });

  it('rewrites the file in place when it cannot be replaced (single-file bind mount)', async () => {
    fs.writeFileSync(settingsPath, saved);
    const settings = await loadSettings();
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw errno('EBUSY');
    });
    setCollections(settings, ['c']);

    settings.save();

    expect(fileCollectionIds(settingsPath)).toEqual(['c']);
    expect(fs.existsSync(`${settingsPath}.tmp`)).toBe(false);
  });

  it('rewrites the file in place when no temp file can be created (read-only directory)', async () => {
    fs.writeFileSync(settingsPath, saved);
    const settings = await loadSettings();
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((file, ...rest) => {
      if (String(file).endsWith('.tmp')) throw errno('EROFS');
      return open(file, ...(rest as [fs.OpenMode]));
    });
    setCollections(settings, ['c']);

    settings.save();

    expect(fileCollectionIds(settingsPath)).toEqual(['c']);
  });

  it('leaves the live file alone when the disk is full', async () => {
    fs.writeFileSync(settingsPath, saved);
    const settings = await loadSettings();
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw errno('ENOSPC');
    });

    expect(() => settings.save()).toThrow('ENOSPC');
    expect(fs.readFileSync(settingsPath, 'utf-8')).toContain('"kept"');
    expect(fs.existsSync(`${settingsPath}.tmp`)).toBe(false);
  });

  it('refreshes the last good copy on every save', async () => {
    fs.writeFileSync(settingsPath, saved);
    const settings = await loadSettings();
    setCollections(settings, ['c']);

    settings.save();

    expect(fileCollectionIds(backupPath)).toEqual(['c']);
  });

  it.skipIf(process.platform === 'win32')(
    'keeps the owner and permissions of settings.json, for the backup too',
    async () => {
      fs.writeFileSync(settingsPath, saved);
      fs.chmodSync(settingsPath, 0o600);
      const { uid, gid } = fs.statSync(settingsPath);
      const settings = await loadSettings();
      const chown = vi.spyOn(fs, 'fchownSync');

      settings.save();

      expect(chown).toHaveBeenCalledWith(expect.any(Number), uid, gid);
      expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(backupPath).mode & 0o777).toBe(0o600);
    }
  );

  it('keeps a symlinked settings.json a symlink', async () => {
    const real = path.join(dir, 'real.json');
    fs.writeFileSync(real, saved);
    fs.symlinkSync(real, settingsPath);
    const settings = await loadSettings();
    setCollections(settings, ['c']);

    settings.save();

    expect(fs.lstatSync(settingsPath).isSymbolicLink()).toBe(true);
    expect(fileCollectionIds(real)).toEqual(['c']);
  });

  it('warns only once when the backup copy cannot be written', async () => {
    fs.writeFileSync(settingsPath, saved);
    const settings = await loadSettings();
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((file, ...rest) => {
      if (String(file).includes('.last-good')) throw errno('EIO');
      return open(file, ...(rest as [fs.OpenMode]));
    });
    vi.mocked(logger.warn).mockClear();

    settings.save();
    settings.save();
    settings.save();

    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
  });
});

describe('Settings.load', () => {
  it('restores the last good copy when settings.json is empty', async () => {
    fs.writeFileSync(settingsPath, saved);
    await loadSettings();
    fs.writeFileSync(settingsPath, '');

    const settings = await loadSettings();

    expect(collectionIds(settings)).toEqual(['a', 'b']);
    expect(fileCollectionIds(settingsPath)).toEqual(['a', 'b']);
  });

  it('restores the last good copy when settings.json is cut short, keeping the bad file aside', async () => {
    fs.writeFileSync(settingsPath, saved);
    await loadSettings();
    fs.writeFileSync(settingsPath, saved.slice(0, 30));

    const settings = await loadSettings();

    expect(collectionIds(settings)).toEqual(['a', 'b']);
    const aside = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('settings.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, aside[0]), 'utf-8')).toBe(
      saved.slice(0, 30)
    );
  });

  it('refuses to overwrite an unreadable settings.json without a backup', async () => {
    fs.writeFileSync(settingsPath, saved.slice(0, 30));

    await expect(loadSettings()).rejects.toThrow('refusing to overwrite');
    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(saved.slice(0, 30));
  });

  it('refuses to start when the last good copy is unreadable too', async () => {
    fs.writeFileSync(settingsPath, saved.slice(0, 30));
    fs.writeFileSync(backupPath, saved.slice(0, 20));

    await expect(loadSettings()).rejects.toThrow('refusing to overwrite');
    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(saved.slice(0, 30));
  });

  it('keeps the settings in memory when the file reads empty after the first load', async () => {
    fs.writeFileSync(settingsPath, saved);
    const settings = await loadSettings();
    setCollections(settings, ['c']);
    fs.writeFileSync(settingsPath, '');

    settings.load();

    expect(collectionIds(settings)).toEqual(['c']);
    expect(fileCollectionIds(settingsPath)).toEqual(['c']);
  });

  it('starts fresh when settings.json was deleted, keeping the old settings aside', async () => {
    fs.writeFileSync(settingsPath, saved);
    await loadSettings();
    fs.rmSync(settingsPath);

    const settings = await loadSettings();

    expect(collectionIds(settings)).toEqual([]);
    const kept = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('settings.json.before-reset-'));
    expect(kept).toHaveLength(1);
    expect(fileCollectionIds(path.join(dir, kept[0]))).toEqual(['a', 'b']);
  });

  it('starts with defaults when there is no settings.json', async () => {
    const settings = await loadSettings();

    expect(collectionIds(settings)).toEqual([]);
    expect(fs.existsSync(settingsPath)).toBe(true);
  });
});

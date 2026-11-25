import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let dir: string;
let settingsPath: string;

const saved = JSON.stringify({
  main: { apiKey: 'kept' },
  plex: { collectionConfigs: [{ id: 'a' }, { id: 'b' }] },
});

const loadSettings = async () => {
  vi.resetModules();
  const { default: Settings } = await import('./settings');
  return new Settings().load();
};

const collectionIds = (settings: { plex: unknown }) =>
  (
    (settings.plex as { collectionConfigs?: { id: string }[] })
      .collectionConfigs ?? []
  ).map((c) => c.id);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agregarr-settings-'));
  settingsPath = path.join(dir, 'settings.json');
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
      fs.truncateSync(file as string, 0);
      throw new Error('interrupted');
    });
    vi.spyOn(fs, 'writeSync').mockImplementation(() => {
      throw new Error('interrupted');
    });

    expect(() => settings.save()).toThrow('interrupted');
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).main.apiKey).toBe(
      'kept'
    );
  });

  it('rewrites the file in place when it cannot be replaced (single-file bind mount)', async () => {
    fs.writeFileSync(settingsPath, saved);
    const settings = await loadSettings();
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === settingsPath) {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      rename(from, to);
    });
    (
      settings.plex as { collectionConfigs: { id: string }[] }
    ).collectionConfigs = [{ id: 'c' }];

    settings.save();

    expect(
      JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).plex.collectionConfigs
    ).toEqual([{ id: 'c' }]);
    expect(fs.existsSync(`${settingsPath}.tmp`)).toBe(false);
  });

  it('refreshes the last good copy on every save', async () => {
    fs.writeFileSync(settingsPath, saved);
    const settings = await loadSettings();
    (
      settings.plex as { collectionConfigs: { id: string }[] }
    ).collectionConfigs = [{ id: 'c' }];

    settings.save();

    expect(
      JSON.parse(fs.readFileSync(`${settingsPath}.last-good`, 'utf-8')).plex
        .collectionConfigs
    ).toEqual([{ id: 'c' }]);
  });
});

describe('Settings.load', () => {
  it('restores the last good copy when settings.json is empty', async () => {
    fs.writeFileSync(settingsPath, saved);
    await loadSettings();
    fs.writeFileSync(settingsPath, '');

    const settings = await loadSettings();

    expect(collectionIds(settings)).toEqual(['a', 'b']);
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).main.apiKey).toBe(
      'kept'
    );
  });

  it('restores the last good copy when settings.json is cut short', async () => {
    fs.writeFileSync(settingsPath, saved);
    await loadSettings();
    fs.writeFileSync(settingsPath, saved.slice(0, 30));

    const settings = await loadSettings();

    expect(collectionIds(settings)).toEqual(['a', 'b']);
  });

  it('refuses to overwrite an unreadable settings.json without a backup', async () => {
    fs.writeFileSync(settingsPath, saved.slice(0, 30));

    await expect(loadSettings()).rejects.toThrow('refusing to overwrite');
    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(saved.slice(0, 30));
  });

  it('keeps the settings in memory when the file reads empty after the first load', async () => {
    fs.writeFileSync(settingsPath, saved);
    const settings = await loadSettings();
    (
      settings.plex as { collectionConfigs: { id: string }[] }
    ).collectionConfigs = [{ id: 'c' }];
    fs.writeFileSync(`${settingsPath}.last-good`, saved);
    fs.writeFileSync(settingsPath, '');

    settings.load();

    expect(collectionIds(settings)).toEqual(['c']);
    expect(
      JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).plex.collectionConfigs
    ).toEqual([{ id: 'c' }]);
  });

  it('keeps a cut-short settings.json aside before restoring', async () => {
    fs.writeFileSync(settingsPath, saved);
    await loadSettings();
    fs.writeFileSync(settingsPath, saved.slice(0, 30));

    await loadSettings();

    const aside = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('settings.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, aside[0]), 'utf-8')).toBe(
      saved.slice(0, 30)
    );
  });

  it('refuses to start when the last good copy is unreadable too', async () => {
    fs.writeFileSync(settingsPath, saved.slice(0, 30));
    fs.writeFileSync(`${settingsPath}.last-good`, saved.slice(0, 20));

    await expect(loadSettings()).rejects.toThrow('refusing to overwrite');
    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(saved.slice(0, 30));
  });

  it('starts with defaults when there is no settings.json', async () => {
    const settings = await loadSettings();

    expect(collectionIds(settings)).toEqual([]);
    expect(fs.existsSync(settingsPath)).toBe(true);
  });
});

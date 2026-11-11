import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ enabled: false, editions: false }));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    main: {
      placeholderFolderTvdbId: state.enabled,
      placeholderEditions: state.editions,
    },
  }),
}));
vi.mock('@server/lib/plexVersion', () => ({
  plexSupportsTvEditions: () => state.editions,
}));

import {
  createPlaceholder,
  resolvePlaceholderPaths,
  scanForMarkerFiles,
  wantsTvdbFolderHint,
} from './placeholderManager';

let base: string;
let lib: string;
let trailer: string;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-tvdb-'));
  lib = path.join(base, 'lib');
  trailer = path.join(base, 'trailer.mp4');
  await fs.mkdir(lib);
  await fs.writeFile(trailer, 'x');
  state.enabled = false;
  state.editions = false;
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

const show = (extra: Record<string, unknown> = {}) => ({
  tmdbId: 42,
  tvdbId: 12345,
  title: 'Some Show',
  year: 2025,
  mediaType: 'tv' as const,
  libraryPath: '/lib',
  ...extra,
});

describe('tv placeholder folder tvdb hint', () => {
  it('hint on builds Title (Year) {tvdb-ID}, hint off is the legacy path', () => {
    const on = resolvePlaceholderPaths(show({ tvdbFolderHint: true }));
    const off = resolvePlaceholderPaths(show());
    expect(on.folderName).toBe('Some Show (2025) {tvdb-12345}');
    expect(on.destinationPath).toBe(
      path.join(
        '/lib',
        'Some Show (2025) {tvdb-12345}',
        'Season 00',
        'S00E00.Trailer.mp4'
      )
    );
    expect(off.folderName).toBe('Some Show (2025)');
  });

  it('puts the id before the edition suffix', () => {
    state.editions = true;
    const on = resolvePlaceholderPaths(show({ tvdbFolderHint: true }));
    expect(on.folderName).toBe(
      'Some Show (2025) {tvdb-12345} {edition-Trailer}'
    );
  });

  it('a Sonarr folder name wins verbatim, hint ignored', () => {
    const r = resolvePlaceholderPaths(
      show({ tvdbFolderHint: true, sonarrFolderName: 'Some Show (2025) [x]' })
    );
    expect(r.folderName).toBe('Some Show (2025) [x]');
  });

  it('no tvdb id keeps the title/year fallback', () => {
    const r = resolvePlaceholderPaths(
      show({ tvdbFolderHint: true, tvdbId: undefined })
    );
    expect(r.folderName).toBe('Some Show (2025)');
  });

  it('setting off, nothing on disk: no hint', async () => {
    expect(await wantsTvdbFolderHint(show({ libraryPath: lib }))).toBe(false);
  });

  it('setting on, nothing on disk: hint', async () => {
    state.enabled = true;
    expect(await wantsTvdbFolderHint(show({ libraryPath: lib }))).toBe(true);
  });

  it('never hints for movies, Sonarr-named shows or shows without an id', async () => {
    state.enabled = true;
    expect(
      await wantsTvdbFolderHint(show({ libraryPath: lib, mediaType: 'movie' }))
    ).toBe(false);
    expect(
      await wantsTvdbFolderHint(
        show({ libraryPath: lib, sonarrFolderName: 'S' })
      )
    ).toBe(false);
    expect(
      await wantsTvdbFolderHint(show({ libraryPath: lib, tvdbId: undefined }))
    ).toBe(false);
  });

  it('toggle on: an existing legacy placeholder keeps its folder', async () => {
    const opts = show({ libraryPath: lib });
    await createPlaceholder({ ...opts, trailerPath: trailer });
    state.enabled = true;
    expect(await wantsTvdbFolderHint(opts)).toBe(false);
  });

  it('toggle off: an existing hinted placeholder keeps its folder', async () => {
    state.enabled = true;
    const opts = show({ libraryPath: lib });
    const hint = await wantsTvdbFolderHint(opts);
    await createPlaceholder({
      ...opts,
      tvdbFolderHint: hint,
      trailerPath: trailer,
    });
    state.enabled = false;
    expect(await wantsTvdbFolderHint(opts)).toBe(true);
  });

  it('a legacy folder owned by a different show does not block the hint', async () => {
    state.enabled = true;
    const other = show({ libraryPath: lib, tmdbId: 777, tvdbId: 888 });
    await createPlaceholder({ ...other, trailerPath: trailer });
    await fs.writeFile(trailer, 'x');
    expect(await wantsTvdbFolderHint(show({ libraryPath: lib }))).toBe(true);
  });

  it('a legacy folder with a matching marker keeps the legacy form', async () => {
    state.enabled = true;
    const opts = show({ libraryPath: lib });
    await createPlaceholder({ ...opts, trailerPath: trailer });
    expect(await wantsTvdbFolderHint(opts)).toBe(false);
  });

  it('a legacy marker with the same tvdb id keeps legacy even if the tmdb id differs', async () => {
    state.enabled = true;
    const opts = show({ libraryPath: lib });
    await createPlaceholder({ ...opts, trailerPath: trailer });
    await fs.writeFile(
      path.join(lib, 'Some Show (2025)', 'Season 00', '.comingsoon'),
      JSON.stringify({ title: 'Some Show', tmdbId: 99, tvdbId: 12345 })
    );
    expect(await wantsTvdbFolderHint({ ...opts, tmdbId: 42 })).toBe(false);
  });

  it('a legacy folder with an unreadable marker keeps the legacy form', async () => {
    state.enabled = true;
    const opts = show({ libraryPath: lib });
    await createPlaceholder({ ...opts, trailerPath: trailer });
    await fs.writeFile(
      path.join(lib, 'Some Show (2025)', 'Season 00', '.comingsoon'),
      'not json'
    );
    expect(await wantsTvdbFolderHint(opts)).toBe(false);
  });

  it('setting on, legacy existence check errors: falls back to legacy', async () => {
    state.enabled = true;
    await fs.writeFile(path.join(lib, 'Some Show (2025)'), 'x');
    expect(await wantsTvdbFolderHint(show({ libraryPath: lib }))).toBe(false);
  });

  it('marker scan finds hinted and legacy folders side by side', async () => {
    const a = show({ libraryPath: lib });
    const b = show({
      libraryPath: lib,
      tmdbId: 43,
      tvdbId: 999,
      title: 'Other',
    });
    await createPlaceholder({ ...a, trailerPath: trailer });
    await fs.writeFile(trailer, 'x');
    await createPlaceholder({
      ...b,
      tvdbFolderHint: true,
      trailerPath: trailer,
    });

    const markers = await scanForMarkerFiles(lib);
    expect(
      markers
        .map((m) => path.basename(path.dirname(path.dirname(m.filePath))))
        .sort()
    ).toEqual(['Other (2025) {tvdb-999}', 'Some Show (2025)']);
    for (const m of markers) {
      await expect(fs.access(m.placeholderPath)).resolves.toBeUndefined();
    }
  });
});

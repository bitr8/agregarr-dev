/**
 * Naming parity test for resolvePlaceholderPaths — the single source of truth
 * for placeholder file/folder naming that BOTH creators and the creation
 * short-circuit consume. If this drifts, short-circuits and DB records point at
 * paths that never exist (silent data loss). Run: npx vitest run server/lib/placeholders
 */
import path from 'path';
import { describe, expect, it } from 'vitest';

import { resolvePlaceholderPaths } from './placeholderManager';

const ROOT = path.join('/library', 'placeholders');

describe('resolvePlaceholderPaths — movie naming', () => {
  it('movie with year: folder + {tmdb} {edition-Trailer} file + sibling marker', () => {
    const r = resolvePlaceholderPaths({
      tmdbId: 123,
      title: 'Test Movie',
      year: 2020,
      mediaType: 'movie',
      libraryPath: ROOT,
    });
    const folder = path.join(ROOT, 'Test Movie (2020)');
    expect(r.folderName).toBe('Test Movie (2020)');
    expect(r.destinationPath).toBe(
      path.join(folder, 'Test Movie (2020) {tmdb-123} {edition-Trailer}.mp4')
    );
    expect(r.markerPath).toBe(path.join(folder, '.comingsoon'));
  });

  it('movie without year: no year suffix', () => {
    const r = resolvePlaceholderPaths({
      tmdbId: 456,
      title: 'Test Movie',
      mediaType: 'movie',
      libraryPath: ROOT,
    });
    expect(r.folderName).toBe('Test Movie');
    expect(r.destinationPath).toBe(
      path.join(
        ROOT,
        'Test Movie',
        'Test Movie {tmdb-456} {edition-Trailer}.mp4'
      )
    );
    expect(r.markerPath).toBe(path.join(ROOT, 'Test Movie', '.comingsoon'));
  });

  it('decodes HTML entities and strips invalid chars in the folder name', () => {
    const r = resolvePlaceholderPaths({
      tmdbId: 789,
      // &amp; -> &, &apos; -> ', then ':' and '?' stripped as invalid chars
      title: 'Ben &amp; Kate&apos;s: Movie?',
      year: 2021,
      mediaType: 'movie',
      libraryPath: ROOT,
    });
    expect(r.folderName).toBe("Ben & Kate's Movie (2021)");
    expect(r.destinationPath).toBe(
      path.join(
        ROOT,
        "Ben & Kate's Movie (2021)",
        "Ben & Kate's Movie (2021) {tmdb-789} {edition-Trailer}.mp4"
      )
    );
  });
});

describe('resolvePlaceholderPaths — TV naming', () => {
  it('TV with sonarrFolderName: folder used VERBATIM (unsanitised)', () => {
    const sonarr = 'The Show (2019) {tvdb-12345}';
    const r = resolvePlaceholderPaths({
      tmdbId: 111,
      tvdbId: 12345,
      title: 'The Show',
      year: 2019,
      mediaType: 'tv',
      libraryPath: ROOT,
      sonarrFolderName: sonarr,
    });
    const seasonDir = path.join(ROOT, sonarr, 'Season 00');
    expect(r.folderName).toBe(sonarr);
    expect(r.destinationPath).toBe(path.join(seasonDir, 'S00E00.Trailer.mp4'));
    expect(r.markerPath).toBe(path.join(seasonDir, '.comingsoon'));
  });

  it('TV without sonarrFolderName: sanitised "Title (Year)"', () => {
    const r = resolvePlaceholderPaths({
      tmdbId: 222,
      title: 'Test Show',
      year: 2018,
      mediaType: 'tv',
      libraryPath: ROOT,
    });
    const seasonDir = path.join(ROOT, 'Test Show (2018)', 'Season 00');
    expect(r.folderName).toBe('Test Show (2018)');
    expect(r.destinationPath).toBe(path.join(seasonDir, 'S00E00.Trailer.mp4'));
    expect(r.markerPath).toBe(path.join(seasonDir, '.comingsoon'));
  });

  it('TV without year: no year suffix', () => {
    const r = resolvePlaceholderPaths({
      tmdbId: 333,
      title: 'Test Show',
      mediaType: 'tv',
      libraryPath: ROOT,
    });
    expect(r.folderName).toBe('Test Show');
    expect(r.markerPath).toBe(
      path.join(ROOT, 'Test Show', 'Season 00', '.comingsoon')
    );
  });
});

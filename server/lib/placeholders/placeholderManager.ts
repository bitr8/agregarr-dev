import type { PlaceholderItem } from '@server/entity/PlaceholderItem';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isContainedPath } from '@server/utils/fileSystemHelpers';
import { constants as fsConstants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import type { PlaceholderOptions, PlaceholderResult } from './types';

/**
 * Ownership proof required to delete a placeholder file. removePlaceholder
 * refuses to unlink unless the caller declares HOW it knows the file is
 * Agregarr's. There is NO default: TypeScript forces every current and future
 * caller to pick one, which is the whole safety property - a delete cannot be
 * added without declaring provenance.
 *
 * - db-record: a coming_soon_item row Agregarr wrote. The caller resolves the
 *   record's absolute path from the RECORD'S OWN config root (not the current
 *   scan root) and passes it as recordAbsPath; the sink requires the requested
 *   path to equal it. Root-bound, so a record under one placeholder root can
 *   never authorise deleting a same-relative-path file under another root.
 * - created-this-run: a file this sync just created via createPlaceholder. Only
 *   reachable from the creation flow, whose tri-state guarantees the path is a
 *   freshly-created or marker-verified placeholder.
 * - marker: verified inside the sink against the on-disk .comingsoon artifact
 *   (plus filename token and, when known, tmdbId). The only proof heuristic
 *   callers (orphan scans) may use.
 */
export type RemovalOwnership =
  | {
      source: 'db-record';
      record: Pick<
        PlaceholderItem,
        'id' | 'tmdbId' | 'placeholderPath' | 'mediaType' | 'configId'
      >;
      recordAbsPath: string;
    }
  | { source: 'created-this-run' }
  | { source: 'marker'; expectedTmdbId?: number };

/**
 * Thrown by removePlaceholder when ownership cannot be proven. Carries a .code
 * so callers detect it the same way they detect ENOENT (the project's
 * ".code not message" convention).
 */
export class PlaceholderOwnershipError extends Error {
  public readonly code = 'EOWNERSHIP';
  public readonly placeholderPath: string;
  constructor(message: string, placeholderPath: string) {
    super(message);
    this.name = 'PlaceholderOwnershipError';
    this.placeholderPath = placeholderPath;
  }
}

/**
 * Resolve a stored placeholderPath (relative to the library's placeholder root)
 * to an absolute path. Legacy rows may hold an absolute path; path.join would
 * double-join those ('/root' + '/abs' -> '/root/abs'), so branch on isAbsolute.
 */
export function resolveRecordPath(root: string, storedPath: string): string {
  const resolved = path.isAbsolute(storedPath)
    ? storedPath
    : path.join(root, storedPath);
  if (!isContainedPath(resolved, root)) {
    throw new Error('Stored placeholder path escapes library root');
  }
  return resolved;
}

/**
 * Sanitize filename to remove invalid characters and decode HTML entities
 */
function sanitizeFilename(filename: string): string {
  return (
    filename
      // Decode HTML entities (from Trakt, Sonarr, etc.)
      .replace(/&apos;/g, "'") // Decode apostrophe
      .replace(/&quot;/g, '"') // Decode quote (then removed below)
      .replace(/&amp;/g, '&') // Decode ampersand
      .replace(/&lt;/g, '<') // Decode less-than (then removed below)
      .replace(/&gt;/g, '>') // Decode greater-than (then removed below)
      .replace(/&#39;/g, "'") // Numeric apostrophe
      .replace(/&#x27;/g, "'") // Hex apostrophe
      .replace(/[<>:"/\\|?*]/g, '') // Remove invalid chars
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim()
  );
}

/**
 * Single source of truth for placeholder file/folder naming. Both creators AND
 * the creation short-circuit consume this, so the path arithmetic (sanitize,
 * year suffix, sonarrFolderName, Season 00) can never drift between "where we
 * write it" and "where we later look for it".
 */
export interface ResolvedPlaceholderPaths {
  folderName: string;
  destinationPath: string;
  markerPath: string;
}

export function resolvePlaceholderPaths(
  options: Omit<PlaceholderOptions, 'trailerPath'>
): ResolvedPlaceholderPaths {
  const { title, year, tmdbId, mediaType, libraryPath, sonarrFolderName } =
    options;

  let result: ResolvedPlaceholderPaths;

  if (mediaType === 'movie') {
    const yearStr = year ? ` (${year})` : '';
    const folderName = `${sanitizeFilename(title)}${yearStr}`;
    const movieFolder = path.join(libraryPath, folderName);
    const filename = `${folderName} {tmdb-${tmdbId}} {edition-Trailer}.mp4`;
    result = {
      folderName,
      destinationPath: path.join(movieFolder, filename),
      markerPath: path.join(movieFolder, '.comingsoon'),
    };
  } else {
    let folderName: string;
    if (sonarrFolderName) {
      folderName = sonarrFolderName;
    } else {
      const yearStr = year ? ` (${year})` : '';
      folderName = `${sanitizeFilename(title)}${yearStr}`;
    }
    const seasonDir = path.join(libraryPath, folderName, 'Season 00');
    result = {
      folderName,
      destinationPath: path.join(seasonDir, 'S00E00.Trailer.mp4'),
      markerPath: path.join(seasonDir, '.comingsoon'),
    };
  }

  if (
    !isContainedPath(result.destinationPath, libraryPath) ||
    !isContainedPath(result.markerPath, libraryPath)
  ) {
    throw new Error(
      `Placeholder path escapes library root: ${result.folderName}`
    );
  }

  return result;
}

/**
 * Create placeholder file for movie
 */
async function createMoviePlaceholder(
  options: PlaceholderOptions
): Promise<PlaceholderResult> {
  const { title, year, tmdbId, trailerPath } = options;

  const { destinationPath, markerPath } = resolvePlaceholderPaths(options);
  const movieFolder = path.dirname(destinationPath);
  const filename = path.basename(destinationPath);

  logger.debug('Creating movie placeholder', {
    label: 'PlaceholderService',
    title,
    filename,
    movieFolder,
    destinationPath,
  });

  // Create movie folder
  await fs.mkdir(movieFolder, { recursive: true });

  // Write .plexmatch so Plex assigns the TMDB GUID during scan rather than
  // waiting for the metadata agent to parse the filename {tmdb-...} tag.
  // Mirrors the TV path — same create-if-absent semantics.
  const plexmatchPath = path.join(movieFolder, '.plexmatch');
  const plexmatchTitle = title.replace(/[\r\n]+/g, ' ').trim();
  const plexmatchLines = [`title: ${plexmatchTitle}`];
  if (year) {
    plexmatchLines.push(`year: ${year}`);
  }
  plexmatchLines.push(`tmdbid: ${tmdbId}`);
  try {
    await fs.writeFile(plexmatchPath, plexmatchLines.join('\n') + '\n', {
      encoding: 'utf-8',
      flag: 'wx',
    });
  } catch (error) {
    const alreadyExists =
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'EEXIST';

    if (!alreadyExists) {
      logger.warn('Failed to write .plexmatch file', {
        label: 'PlaceholderService',
        title,
        path: plexmatchPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Copy trailer to movie folder. COPYFILE_EXCL: never clobber a file already
  // at the destination (a real user file, or a concurrent create). The creation
  // short-circuit checks for an existing destination first, so the normal path
  // never hits EEXIST; if it does, it is a refusal, surfaced by the caller.
  await fs.copyFile(trailerPath, destinationPath, fsConstants.COPYFILE_EXCL);

  // Write the .comingsoon marker (atomic) for identification. Mirrors the TV
  // path so there is ONE authoritative "Agregarr authored this" signal on disk
  // - the gate the orphan-deletion path checks. The filename tokens
  // ({tmdb-...}/{edition-Trailer}) are standard Plex conventions a real user
  // can apply to their own media, so they cannot prove authorship alone.
  await writeMarkerAtomic(markerPath, {
    createdAt: new Date().toISOString(),
    title,
    year,
    tmdbId,
  });

  // Clean up temporary trailer file
  try {
    await fs.unlink(trailerPath);
    logger.debug('Cleaned up temporary trailer file', {
      label: 'PlaceholderService',
      path: trailerPath,
    });
  } catch (error) {
    logger.warn('Failed to clean up temporary trailer file', {
      label: 'PlaceholderService',
      path: trailerPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logger.info('Created movie placeholder', {
    label: 'PlaceholderService',
    title,
    filename,
  });

  return {
    placeholderPath: destinationPath,
    filename,
  };
}

/**
 * Create placeholder file for TV show
 */
async function createTVPlaceholder(
  options: PlaceholderOptions
): Promise<PlaceholderResult> {
  const { title, year, trailerPath, sonarrFolderName } = options;

  // Directory format: ShowName (Year)/Season 00/S00E00.Trailer.mp4
  // resolvePlaceholderPaths is the single source of truth for the layout
  // (sonarrFolderName wins verbatim so Plex doesn't split the show).
  const { destinationPath, markerPath } = resolvePlaceholderPaths(options);
  const seasonDir = path.dirname(destinationPath);
  const showDir = path.dirname(seasonDir);
  const filename = path.basename(destinationPath);
  if (sonarrFolderName) {
    logger.debug('Using Sonarr folder name for TV placeholder', {
      label: 'PlaceholderService',
      title,
      sonarrFolderName,
    });
  }

  logger.debug('Creating TV show placeholder', {
    label: 'PlaceholderService',
    title,
    showDir,
    seasonDir,
  });

  // Create directories
  await fs.mkdir(seasonDir, { recursive: true });

  // Write a .plexmatch file so Plex matches the show deterministically.
  // Title/year matching fails for obscure shows, which leaves the item without
  // a tmdb:// GUID and makes discovery treat the placeholder as unmatched.
  const plexmatchPath = path.join(showDir, '.plexmatch');
  const plexmatchTitle = title.replace(/[\r\n]+/g, ' ').trim();
  const plexmatchLines = [`title: ${plexmatchTitle}`];
  if (year) {
    plexmatchLines.push(`year: ${year}`);
  }
  plexmatchLines.push(`tmdbid: ${options.tmdbId}`);
  if (options.tvdbId) {
    plexmatchLines.push(`tvdbid: ${options.tvdbId}`);
  }
  try {
    // wx: fail if the file exists - never clobber manual match hints,
    // especially in Sonarr-named folders that may pre-exist
    await fs.writeFile(plexmatchPath, plexmatchLines.join('\n') + '\n', {
      encoding: 'utf-8',
      flag: 'wx',
    });
  } catch (error) {
    const alreadyExists =
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'EEXIST';

    if (!alreadyExists) {
      logger.warn('Failed to write .plexmatch file', {
        label: 'PlaceholderService',
        title,
        path: plexmatchPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Copy trailer file (COPYFILE_EXCL: never clobber an existing file).
  await fs.copyFile(trailerPath, destinationPath, fsConstants.COPYFILE_EXCL);

  // Clean up temporary trailer file
  try {
    await fs.unlink(trailerPath);
    logger.debug('Cleaned up temporary trailer file', {
      label: 'PlaceholderService',
      path: trailerPath,
    });
  } catch (error) {
    logger.warn('Failed to clean up temporary trailer file', {
      label: 'PlaceholderService',
      path: trailerPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Create .comingsoon marker file for identification (atomic write)
  await writeMarkerAtomic(markerPath, {
    createdAt: new Date().toISOString(),
    title,
    year,
    tmdbId: options.tmdbId,
    tvdbId: options.tvdbId,
  });

  logger.info('Created TV show placeholder', {
    label: 'PlaceholderService',
    title,
    filename: destinationPath,
  });

  return {
    placeholderPath: destinationPath,
    filename,
  };
}

/**
 * Create placeholder file in Plex library
 */
export async function createPlaceholder(
  options: PlaceholderOptions
): Promise<PlaceholderResult> {
  const { mediaType } = options;

  try {
    if (mediaType === 'movie') {
      return await createMoviePlaceholder(options);
    } else {
      return await createTVPlaceholder(options);
    }
  } catch (error) {
    logger.error('Failed to create placeholder', {
      label: 'PlaceholderService',
      error: error instanceof Error ? error.message : String(error),
      title: options.title,
      mediaType: options.mediaType,
    });
    throw error;
  }
}

/**
 * Remove placeholder file
 */
export async function removePlaceholder(
  placeholderPath: string,
  mediaType: 'movie' | 'tv',
  ownership: RemovalOwnership
): Promise<void> {
  try {
    // Security: Validate path is within configured library roots to prevent path traversal
    const settings = getSettings();
    const libraryRoots =
      mediaType === 'movie'
        ? settings.main.placeholderMovieRootFolders
        : settings.main.placeholderTVRootFolders;

    if (!libraryRoots || Object.keys(libraryRoots).length === 0) {
      throw new Error(
        `Placeholder ${mediaType} library root not configured - cannot safely delete`
      );
    }

    // Resolve both paths to real paths (following symlinks) to prevent symlink escape attacks
    // This ensures even if an attacker creates a symlink inside the library pointing outside,
    // we check the actual destination, not the symlink path
    // NOTE: We fail hard on realpath errors - no unsafe fallback to path.resolve()
    let realPath: string;

    try {
      realPath = await fs.realpath(placeholderPath);
    } catch (realpathError) {
      // File doesn't exist or can't be resolved - this is a security issue, fail hard.
      // ENOENT (file already gone) is expected and handled by callers, so log
      // it quietly; anything else (permissions, mount issues) stays an error.
      const isFileNotFound =
        realpathError instanceof Error &&
        'code' in realpathError &&
        (realpathError as NodeJS.ErrnoException).code === 'ENOENT';
      logger[isFileNotFound ? 'debug' : 'error'](
        'Cannot resolve real path for placeholder deletion',
        {
          label: 'PlaceholderService',
          requestedPath: placeholderPath,
          error:
            realpathError instanceof Error
              ? realpathError.message
              : String(realpathError),
        }
      );
      const err = new Error(
        'Cannot resolve placeholder path - file may not exist or permissions denied'
      );
      if (realpathError instanceof Error && 'code' in realpathError) {
        (err as NodeJS.ErrnoException).code = (
          realpathError as NodeJS.ErrnoException
        ).code;
      }
      throw err;
    }

    // Find which configured library root contains this placeholder
    let matchedRoot: string | undefined;
    for (const libraryRoot of Object.values(libraryRoots)) {
      try {
        const realRoot = await fs.realpath(libraryRoot);
        if (realPath.startsWith(realRoot + path.sep) || realPath === realRoot) {
          matchedRoot = realRoot;
          break;
        }
      } catch (rootRealpathError) {
        // This library root can't be resolved, skip it
        logger.warn('Cannot resolve library root path', {
          label: 'PlaceholderService',
          libraryRoot,
          error:
            rootRealpathError instanceof Error
              ? rootRealpathError.message
              : String(rootRealpathError),
        });
        continue;
      }
    }

    // Validate the resolved path is within one of the configured library roots
    if (!matchedRoot) {
      logger.error(
        'Path traversal attempt detected - refusing to delete file outside library roots',
        {
          label: 'PlaceholderService',
          requestedPath: placeholderPath,
          realPath,
          configuredRoots: Object.values(libraryRoots),
          mediaType,
        }
      );
      throw new Error(
        'Invalid placeholder path - path traversal detected, file is outside configured library roots'
      );
    }

    // Safety check: Verify path contains placeholder marker (supports both old and new format)
    if (
      !placeholderPath.includes('{edition-Trailer}') &&
      !placeholderPath.includes('{edition-Placeholder}') &&
      !placeholderPath.includes('{edition-Coming Soon}') &&
      !placeholderPath.includes('S00E00.Trailer.mp4')
    ) {
      logger.warn(
        'Refusing to delete - path does not appear to be a placeholder',
        {
          label: 'PlaceholderService',
          path: placeholderPath,
          mediaType,
        }
      );
      throw new Error('Invalid placeholder path - missing placeholder markers');
    }

    // Ownership gate: proven authorship required before the irreversible unlink.
    // The invariants above (root containment, filename token) already passed for
    // every ownership kind; this is the provenance proof a heuristic cannot fake.
    // Throws PlaceholderOwnershipError (code EOWNERSHIP) on any doubt.
    if (ownership.source === 'db-record') {
      // Root-bound backstop: the caller resolves recordAbsPath from the RECORD'S
      // OWN config root, so a same-relative-path file under a different root will
      // not match. Compare the REAL paths of both (realPath is already the
      // realpath of the file being deleted): resolving both the same way keeps a
      // symlinked/mergerfs root (e.g. /mnt/user -> /mnt/diskN) matching for a
      // correct caller, while catching any future caller whose recordAbsPath
      // points at a different real file. recordAbsPath == the file here, so its
      // realpath succeeds; fall back to path.resolve only if it somehow doesn't.
      const norm = (p: string) => path.resolve(p).replace(/\\/g, '/');
      let recordReal: string;
      try {
        recordReal = await fs.realpath(ownership.recordAbsPath);
      } catch {
        recordReal = ownership.recordAbsPath;
      }
      if (norm(realPath) !== norm(recordReal)) {
        throw new PlaceholderOwnershipError(
          'db-record ownership path does not match the file being deleted (cross-root or mismatched record)',
          placeholderPath
        );
      }
      if (mediaType !== ownership.record.mediaType) {
        throw new PlaceholderOwnershipError(
          'db-record ownership mediaType mismatch',
          placeholderPath
        );
      }
    } else if (ownership.source === 'marker') {
      const proven = await verifyPlaceholderMarker(
        realPath,
        mediaType,
        ownership.expectedTmdbId
      );
      if (!proven) {
        throw new PlaceholderOwnershipError(
          'no positive .comingsoon marker on disk - not provably an Agregarr placeholder',
          placeholderPath
        );
      }
    }
    // created-this-run: no further check (single call site, tri-state guarded).

    logger.debug('Removing placeholder', {
      label: 'PlaceholderService',
      path: placeholderPath,
      mediaType,
    });

    // Delete the file
    await fs.unlink(placeholderPath);

    // Clean up associated .trickplay directory (Jellyfin creates these for video thumbnails)
    // Pattern: "Movie {tmdb-123} {edition-Trailer}.mp4" -> "Movie {tmdb-123} {edition-Trailer}.trickplay"
    if (placeholderPath.endsWith('.mp4')) {
      const trickplayPath = placeholderPath.replace(/\.mp4$/, '.trickplay');
      try {
        const trickplayStat = await fs.stat(trickplayPath);
        if (trickplayStat.isDirectory()) {
          await fs.rm(trickplayPath, { recursive: true });
          logger.debug('Removed associated trickplay directory', {
            label: 'PlaceholderService',
            path: trickplayPath,
          });
        }
      } catch {
        // Trickplay directory doesn't exist, that's fine
      }
    }

    // Clean up parent directories if empty
    if (mediaType === 'movie') {
      const movieDir = path.dirname(placeholderPath);

      // Remove metadata files written at creation time so the movie
      // folder can be recognised as empty.
      for (const metaFile of ['.comingsoon', '.plexmatch']) {
        try {
          await fs.unlink(path.join(movieDir, metaFile));
        } catch {
          // File might not exist (legacy placeholder), ignore
        }
      }

      // Try to remove movie directory if it's empty
      try {
        const files = await fs.readdir(movieDir);
        if (files.length === 0) {
          await fs.rmdir(movieDir);
          logger.debug('Removed empty movie directory', {
            label: 'PlaceholderService',
            path: movieDir,
          });
        }
      } catch {
        // Directory not empty or other error, ignore
      }
    } else if (mediaType === 'tv') {
      const seasonDir = path.dirname(placeholderPath);
      const showDir = path.dirname(seasonDir);

      // Remove .comingsoon marker if it exists
      const markerPath = path.join(seasonDir, '.comingsoon');
      try {
        await fs.unlink(markerPath);
      } catch {
        // Marker file might not exist, ignore
      }

      // Try to remove Season 00 directory if it's empty
      try {
        const files = await fs.readdir(seasonDir);
        if (files.length === 0) {
          await fs.rmdir(seasonDir);
          logger.debug('Removed empty season directory', {
            label: 'PlaceholderService',
            path: seasonDir,
          });

          // Try to remove show directory if it's empty.
          // A leftover .plexmatch counts as empty - it only exists for the
          // placeholder. If real content merged into the folder, leave it.
          let showFiles = await fs.readdir(showDir);
          if (showFiles.length === 1 && showFiles[0] === '.plexmatch') {
            await fs.unlink(path.join(showDir, '.plexmatch'));
            showFiles = [];
          }
          if (showFiles.length === 0) {
            await fs.rmdir(showDir);
            logger.debug('Removed empty show directory', {
              label: 'PlaceholderService',
              path: showDir,
            });
          }
        }
      } catch {
        // Directory not empty or other error, ignore
      }
    }

    logger.info('Removed placeholder successfully', {
      label: 'PlaceholderService',
      path: placeholderPath,
    });
  } catch (error) {
    // ENOENT (file already gone) and EOWNERSHIP (deliberate refusal - the
    // caller handles it with its own warn/skip) are both expected control-flow
    // outcomes, not failures. Don't error-log them here.
    const code =
      error instanceof Error && 'code' in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code !== 'ENOENT' && code !== 'EOWNERSHIP') {
      logger.error('Failed to remove placeholder', {
        label: 'PlaceholderService',
        error: error instanceof Error ? error.message : String(error),
        path: placeholderPath,
      });
    }
    throw error;
  }
}

/**
 * Marker file content structure
 */
export interface PlaceholderMarker {
  createdAt: string;
  title: string;
  year?: number;
  tmdbId?: number; // Optional for backward compatibility with old markers
  tvdbId?: number;
  // Set by the global orphan sweep on first sighting of a record-less but
  // Agregarr-marked file; the deletion grace runs from here. Cleared by the
  // creation short-circuit when the item is resumed (proof it is still wanted),
  // so a still-wanted quarantined placeholder never ages out.
  orphanedAt?: string;
  // Set when the marker was back-filled onto a DB-tracked placeholder that
  // predated markers (never inferred from filename tokens).
  backfilled?: boolean;
}

/**
 * Discovered marker with file path
 */
export interface DiscoveredMarker extends PlaceholderMarker {
  filePath: string; // Path to the .comingsoon marker file
  placeholderPath: string; // Path to the S00E00.Trailer.mp4 file
}

/**
 * Read and parse the .comingsoon marker in a directory. Returns null when the
 * marker is missing OR unparseable (callers must not treat null as "deletable").
 */
export async function readPlaceholderMarker(
  dir: string
): Promise<PlaceholderMarker | null> {
  try {
    const raw = await fs.readFile(path.join(dir, '.comingsoon'), 'utf-8');
    return JSON.parse(raw) as PlaceholderMarker;
  } catch {
    return null;
  }
}

/**
 * Write a marker atomically: write a sibling temp file then rename into place
 * (atomic on POSIX within the same directory), so a concurrent reader never
 * sees a torn JSON marker. Used by the creators, marker back-fill's callers,
 * upgradeMarkerFile, and the orphan stamp/clear helpers.
 */
async function writeMarkerAtomic(
  markerPath: string,
  marker: PlaceholderMarker
): Promise<void> {
  const tmpPath = `${markerPath}.tmp-${process.pid}`;
  await fs.writeFile(tmpPath, JSON.stringify(marker), 'utf-8');
  await fs.rename(tmpPath, markerPath);
}

/**
 * Positive on-disk marker check required before deleting a record-less orphaned
 * placeholder. Heuristic detection (isPlaceholderItemAsync, filename tokens) can
 * false-positive on real media, so deletion additionally requires the
 * `.comingsoon` marker only Agregarr's creation flow writes. The marker is the
 * AUTHORITATIVE gate; filename tokens are a secondary signal, never sufficient
 * alone. Returns false on any doubt. (Moved here from PlaceholderCreation so the
 * deletion sink verifies ownership itself.)
 */
export async function verifyPlaceholderMarker(
  placeholderFilePath: string,
  mediaType: 'movie' | 'tv',
  expectedTmdbId?: number
): Promise<boolean> {
  const filename = path.basename(placeholderFilePath);
  const markerDir = path.dirname(placeholderFilePath);

  const marker = await readPlaceholderMarker(markerDir);
  if (marker === null) {
    // No marker OR a torn/unparseable one: fail closed either way. A corrupt
    // marker downgrades to the leak tier, never to a delete - we cannot read
    // its tmdbId to cross-check, so authorising deletion on filename tokens
    // alone would defeat the marker gate. (Atomic writes mean Agregarr never
    // produces a torn marker; the sweep likewise treats null as unproven.)
    return false;
  }
  if (
    expectedTmdbId !== undefined &&
    marker.tmdbId !== undefined &&
    marker.tmdbId !== expectedTmdbId
  ) {
    return false; // marker belongs to a different item
  }

  if (mediaType === 'movie') {
    if (!filename.includes('{edition-Trailer}')) {
      return false;
    }
    const tmdbMatch = filename.match(/\{tmdb-(\d+)\}/);
    const filenameTmdbId = tmdbMatch ? parseInt(tmdbMatch[1], 10) : undefined;
    // Bind the file being deleted to the marker's OWN identity. A movie marker
    // sits in the folder and can be back-filled for the whole folder, so a
    // sibling `*{edition-Trailer}*.mp4` that lacks a matching `{tmdb-N}` token
    // must not be delete-authorised by another file's marker. Agregarr always
    // writes `{tmdb-N}` matching the marker, so a genuine placeholder passes;
    // this closes the gap where the global sweep supplies expectedTmdbId=
    // undefined (it parses the id from the target's own filename, so a
    // token-less sibling yields undefined and skips the cross-check).
    if (marker.tmdbId !== undefined && filenameTmdbId !== marker.tmdbId) {
      return false;
    }
    if (expectedTmdbId !== undefined && filenameTmdbId !== expectedTmdbId) {
      return false;
    }
    return true;
  }

  // TV: filename must be our trailer file.
  return filename.includes('S00E00') && filename.includes('Trailer');
}

/**
 * Stamp `orphanedAt` on a record-less-but-marked placeholder's marker so the
 * deletion grace can start. Returns false (and does NOT delete-authorise) when
 * the marker is missing/unparseable or the write fails - fail-safe: no delete
 * without a successfully persisted grace start.
 */
export async function stampMarkerOrphaned(dir: string): Promise<boolean> {
  const marker = await readPlaceholderMarker(dir);
  if (!marker) {
    return false;
  }
  if (marker.orphanedAt) {
    return true; // already stamped
  }
  try {
    await writeMarkerAtomic(path.join(dir, '.comingsoon'), {
      ...marker,
      orphanedAt: new Date().toISOString(),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear `orphanedAt` (item is wanted again). No-op when the marker is missing
 * or already has no orphanedAt, so the steady state does zero marker writes.
 */
export async function clearMarkerOrphaned(dir: string): Promise<void> {
  const marker = await readPlaceholderMarker(dir);
  if (!marker || !marker.orphanedAt) {
    return;
  }
  const rest = { ...marker };
  delete rest.orphanedAt;
  try {
    await writeMarkerAtomic(path.join(dir, '.comingsoon'), rest);
  } catch {
    // best-effort
  }
}

/**
 * Scan a library directory for .comingsoon marker files
 * Returns all discovered markers with their file paths
 */
export async function scanForMarkerFiles(
  libraryPath: string
): Promise<DiscoveredMarker[]> {
  const markers: DiscoveredMarker[] = [];

  try {
    // Get all items in the library root
    const items = await fs.readdir(libraryPath, { withFileTypes: true });

    for (const item of items) {
      if (!item.isDirectory()) continue;

      const showDir = path.join(libraryPath, item.name);
      const season00Dir = path.join(showDir, 'Season 00');

      // Check if Season 00 exists
      try {
        const season00Stat = await fs.stat(season00Dir);
        if (!season00Stat.isDirectory()) continue;
      } catch {
        continue; // Season 00 doesn't exist
      }

      // Check for .comingsoon marker
      const markerPath = path.join(season00Dir, '.comingsoon');
      try {
        const markerContent = await fs.readFile(markerPath, 'utf-8');
        const markerData = JSON.parse(markerContent) as PlaceholderMarker;

        // Path to the actual placeholder file
        const placeholderPath = path.join(season00Dir, 'S00E00.Trailer.mp4');

        markers.push({
          ...markerData,
          filePath: markerPath,
          placeholderPath,
        });

        logger.debug('Found placeholder marker', {
          label: 'PlaceholderManager',
          title: markerData.title,
          hasTmdbId: !!markerData.tmdbId,
          path: markerPath,
        });
      } catch (error) {
        // Marker file doesn't exist or is invalid JSON - skip
        logger.debug('No valid marker found in Season 00', {
          label: 'PlaceholderManager',
          path: season00Dir,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('Scanned library for placeholder markers', {
      label: 'PlaceholderManager',
      libraryPath,
      markersFound: markers.length,
      withTmdbId: markers.filter((m) => m.tmdbId).length,
      withoutTmdbId: markers.filter((m) => !m.tmdbId).length,
    });

    return markers;
  } catch (error) {
    logger.error('Failed to scan for marker files', {
      label: 'PlaceholderManager',
      libraryPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Upgrade an old marker file to include tmdbId and tvdbId
 */
export async function upgradeMarkerFile(
  markerPath: string,
  tmdbId: number,
  tvdbId?: number
): Promise<void> {
  try {
    // Read existing marker
    const markerContent = await fs.readFile(markerPath, 'utf-8');
    const markerData = JSON.parse(markerContent) as PlaceholderMarker;

    // Add tmdbId and tvdbId (preserves unknown fields via the spread)
    const upgradedMarker = {
      ...markerData,
      tmdbId,
      tvdbId,
    };

    // Write back to file atomically (markerPath is the .comingsoon file itself)
    await writeMarkerAtomic(markerPath, upgradedMarker);

    logger.info('Upgraded marker file with TMDB ID', {
      label: 'PlaceholderManager',
      title: markerData.title,
      tmdbId,
      tvdbId,
      path: markerPath,
    });
  } catch (error) {
    logger.error('Failed to upgrade marker file', {
      label: 'PlaceholderManager',
      path: markerPath,
      tmdbId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Discovered movie placeholder with metadata extracted from filename
 */
export interface DiscoveredMoviePlaceholder {
  title: string; // Extracted from folder name
  year?: number; // Extracted from folder name
  tmdbId: number; // Extracted from {tmdb-12345}
  placeholderPath: string; // Full path to the .mp4 file
  folderPath: string; // Path to the movie folder
}

/**
 * Scan a movie library directory for placeholder files based on filename pattern
 * Movies use {edition-Trailer} and {tmdb-12345} in filename - no marker file needed
 * Returns all discovered movie placeholders with extracted metadata
 */
export async function scanForMoviePlaceholders(
  libraryPath: string
): Promise<DiscoveredMoviePlaceholder[]> {
  const placeholders: DiscoveredMoviePlaceholder[] = [];

  try {
    // Get all items in the library root
    const items = await fs.readdir(libraryPath, { withFileTypes: true });

    for (const item of items) {
      if (!item.isDirectory()) continue;

      const movieFolder = path.join(libraryPath, item.name);

      // Check for placeholder files in this folder
      try {
        const entries = await fs.readdir(movieFolder, { withFileTypes: true });

        for (const entry of entries) {
          // Skip directories (e.g., Jellyfin .trickplay folders when sharing libraries)
          if (!entry.isFile()) continue;

          const file = entry.name;

          // Look for files with {edition-Trailer} pattern
          if (
            !file.includes('{edition-Trailer}') &&
            !file.includes('{edition-Placeholder}') &&
            !file.includes('{edition-Coming Soon}')
          ) {
            continue;
          }

          // Extract TMDB ID from {tmdb-12345} pattern
          const tmdbMatch = file.match(/\{tmdb-(\d+)\}/);
          if (!tmdbMatch) {
            logger.warn('Placeholder file missing TMDB ID in filename', {
              label: 'PlaceholderManager',
              file,
              folder: movieFolder,
            });
            continue;
          }

          const tmdbId = parseInt(tmdbMatch[1], 10);

          // Extract title and year from folder name
          // Format: "MovieTitle (Year)" or "MovieTitle"
          const folderName = item.name;
          const yearMatch = folderName.match(/\((\d{4})\)$/);
          const year = yearMatch ? parseInt(yearMatch[1], 10) : undefined;
          const title = yearMatch
            ? folderName.substring(0, folderName.lastIndexOf('(')).trim()
            : folderName;

          const placeholderPath = path.join(movieFolder, file);

          placeholders.push({
            title,
            year,
            tmdbId,
            placeholderPath,
            folderPath: movieFolder,
          });

          logger.debug('Found movie placeholder', {
            label: 'PlaceholderManager',
            title,
            year,
            tmdbId,
            path: placeholderPath,
          });

          // Only process first placeholder file per folder
          break;
        }
      } catch (error) {
        // Can't read folder contents, skip
        logger.debug('Could not read movie folder', {
          label: 'PlaceholderManager',
          path: movieFolder,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('Scanned movie library for placeholders', {
      label: 'PlaceholderManager',
      libraryPath,
      placeholdersFound: placeholders.length,
    });

    return placeholders;
  } catch (error) {
    logger.error('Failed to scan for movie placeholders', {
      label: 'PlaceholderManager',
      libraryPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

import type PlexAPI from '@server/api/plexapi';
import { getRepository } from '@server/datasource';
import { ComingSoonItem } from '@server/entity/ComingSoonItem';
import {
  findPlexItemsByTitle,
  findPlexItemsByTmdbIds,
} from '@server/lib/collections/core/CollectionUtilities';
import type {
  CollectionItem,
  ComingSoonSourceData,
  MissingItem,
  PlaceholderSourceData,
} from '@server/lib/collections/core/types';
import type { CollectionConfig, Library } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import path from 'path';
import type { GhostDeletion } from './PlaceholderCleanup';
import { ensurePlaceholderEpisodeTitle } from './PlaceholderTitleFixer';
import {
  clearUnmatchedPlaceholder,
  filterRecentlyUnmatched,
  recordUnmatchedPlaceholder,
} from './unmatchedPlaceholderCache';

/**
 * Process missing items as placeholders for a collection
 * This is the main entry point for any collection type wanting to create placeholders
 */
export async function processPlaceholdersForMissingItems(
  missingItems: MissingItem[],
  config: CollectionConfig,
  plexClient: PlexAPI
): Promise<CollectionItem[]> {
  if (!isPlaceholderCreationEnabled(config)) {
    return [];
  }

  if (missingItems.length === 0) {
    return [];
  }

  // For normal collections (not Coming Soon), create placeholders for ALL missing items
  // For Coming Soon collections, only create placeholders for items with release dates
  const isComingSoonCollection = config.type === 'comingsoon';

  // Convert missing items to placeholder source data
  const sourceData = missingItemsToPlaceholderSourceData(
    missingItems,
    isComingSoonCollection // Only require release dates for Coming Soon collections
  );

  if (sourceData.length === 0) {
    const message = isComingSoonCollection
      ? 'No missing items have sufficient release date metadata for placeholder creation'
      : 'No missing items to create placeholders for';

    logger.info(message, {
      label: 'PlaceholderService',
      configName: config.name,
      originalCount: missingItems.length,
      collectionType: config.type,
    });
    return [];
  }

  // Enrich source data with TMDB release dates for items that don't have them
  // This is critical for regular collections (IMDb, Trakt, Letterboxd) which don't populate release dates
  const { enrichWithTMDBReleaseDates } = await import(
    '@server/lib/collections/sources/comingsoon/comingSoonFetch'
  );
  const daysAhead = getDaysAhead(config);
  const releasedDays = getReleasedDays(config);
  const includeAllReleased = config.includeAllReleasedItems ?? true;

  // Skip date filtering in enrichment when includeAllReleasedItems is true for non-Coming-Soon collections
  // The filtering will happen below with proper includeAllReleasedItems logic
  const skipDateFilter = includeAllReleased && !isComingSoonCollection;
  await enrichWithTMDBReleaseDates(
    sourceData,
    daysAhead,
    releasedDays,
    skipDateFilter
  );

  // Filter by date window - only create placeholders for items within the configured window
  // When includeAllReleasedItems is true: include all past items, only filter by daysAhead for future
  // When includeAllReleasedItems is false: use window from releasedDays in past to daysAhead in future
  const { isDateWithinDays, isDateWithinFutureDays, determineReleaseDate } =
    await import('@server/utils/dateHelpers');

  const filteredSourceData = sourceData.filter((item) => {
    // Determine the effective release date to check
    let releaseDateToCheck: string | undefined;

    if (item.mediaType === 'movie') {
      // Use the shared determineReleaseDate function which handles:
      // Priority 1: Earliest of Digital or Physical release
      // Priority 2: Theatrical + 90 days estimate
      const result = determineReleaseDate(
        item.digitalRelease,
        item.physicalRelease,
        item.inCinemas
      );
      if (result) {
        releaseDateToCheck = result.releaseDate;
      } else if (item.releaseDate) {
        // Fallback to generic release date if specific dates unavailable
        releaseDateToCheck = item.releaseDate;
      }
    } else if (item.mediaType === 'tv') {
      // For TV: use air date
      releaseDateToCheck = item.airDate;
    }

    // If no release date after TMDB enrichment, exclude the item
    // This prevents creating placeholders for items with unknown release dates
    // when user has specified a specific date window
    if (!releaseDateToCheck) {
      logger.debug(
        'Skipping placeholder creation - no release date available after TMDB enrichment',
        {
          label: 'PlaceholderService',
          title: item.title,
          tmdbId: item.tmdbId,
          mediaType: item.mediaType,
          configName: config.name,
        }
      );
      return false;
    }

    // Check if release date is within the configured window
    // When includeAllReleased is true: only check future limit (all past items included)
    // When includeAllReleased is false: check both past and future limits
    const withinWindow = includeAllReleased
      ? isDateWithinFutureDays(releaseDateToCheck, daysAhead)
      : isDateWithinDays(releaseDateToCheck, daysAhead, releasedDays);

    if (!withinWindow) {
      logger.debug(
        'Skipping placeholder creation - release date outside configured window',
        {
          label: 'PlaceholderService',
          title: item.title,
          releaseDate: releaseDateToCheck,
          daysAhead,
          releasedDays,
          includeAllReleased,
          configName: config.name,
        }
      );
    }

    return withinWindow;
  });

  const skippedByDateFilter = sourceData.length - filteredSourceData.length;

  if (filteredSourceData.length === 0) {
    logger.info(
      'No items within configured date window for placeholder creation',
      {
        label: 'PlaceholderService',
        configName: config.name,
        originalCount: missingItems.length,
        skippedNoReleaseDateMetadata: missingItems.length - sourceData.length,
        skippedByDateFilter,
        daysAhead,
        releasedDays,
        collectionType: config.type,
      }
    );
    return [];
  }

  logger.info('Creating placeholders for missing items', {
    label: 'PlaceholderService',
    configName: config.name,
    itemCount: filteredSourceData.length,
    skippedNoReleaseDateMetadata: missingItems.length - sourceData.length,
    skippedByDateFilter,
    daysAhead,
    releasedDays,
    collectionType: config.type,
  });

  // Filter missingItems to only those that have filteredSourceData
  const tmdbIdsWithSourceData = new Set(
    filteredSourceData.map((s) => s.tmdbId)
  );
  const filteredMissingItems = missingItems.filter((item) =>
    tmdbIdsWithSourceData.has(item.tmdbId)
  );

  // Check *arr download status before creating placeholders
  // This prevents re-creating placeholders when content has been downloaded
  // but Plex hasn't scanned it yet (race condition fix for issue #390)
  // Uses batch lookup to fetch *arr libraries once instead of per-item
  const { placeholderContextService } = await import(
    '@server/lib/placeholders/services/PlaceholderContextService'
  );

  // Batch fetch download status from *arr (fetches libraries once)
  const { moviesByTmdbId, showsByTvdbId } =
    await placeholderContextService.batchCheckDownloadStatus(
      filteredMissingItems.map((item) => ({
        tmdbId: item.tmdbId,
        tvdbId: item.tvdbId,
        mediaType: item.mediaType,
      }))
    );

  const itemsNotDownloaded: MissingItem[] = [];
  let skippedAlreadyDownloaded = 0;

  for (const item of filteredMissingItems) {
    let isDownloaded = false;

    if (item.mediaType === 'movie') {
      const radarrStatus = moviesByTmdbId.get(item.tmdbId);
      isDownloaded = radarrStatus?.downloaded ?? false;
    } else if (item.mediaType === 'tv' && item.tvdbId) {
      const sonarrStatus = showsByTvdbId.get(item.tvdbId);
      isDownloaded = sonarrStatus?.downloaded ?? false;
    }

    if (isDownloaded) {
      skippedAlreadyDownloaded++;
      logger.debug(
        'Skipping placeholder creation - content already downloaded in *arr',
        {
          label: 'PlaceholderService',
          title: item.title,
          tmdbId: item.tmdbId,
          mediaType: item.mediaType,
        }
      );
    } else {
      itemsNotDownloaded.push(item);
    }
  }

  if (skippedAlreadyDownloaded > 0) {
    logger.info(
      'Skipped placeholder creation for items already downloaded in *arr',
      {
        label: 'PlaceholderService',
        configName: config.name,
        skippedCount: skippedAlreadyDownloaded,
        remainingCount: itemsNotDownloaded.length,
      }
    );
  }

  if (itemsNotDownloaded.length === 0) {
    logger.info('No items need placeholders after *arr download check', {
      label: 'PlaceholderService',
      configName: config.name,
      originalCount: missingItems.length,
      skippedAlreadyDownloaded,
    });
    return [];
  }

  // Skip items Plex recently failed to match - retrying every sync re-downloads
  // the same trailers and burns hours on placeholders that get deleted again
  const itemsToCreate = await filterRecentlyUnmatched(
    config.libraryId,
    itemsNotDownloaded
  );

  if (itemsToCreate.length === 0) {
    logger.info('All remaining items are in the unmatched placeholder cache', {
      label: 'PlaceholderService',
      configName: config.name,
      skippedUnmatched: itemsNotDownloaded.length,
    });
    return [];
  }

  // Filter sourceData to match remaining items
  const remainingTmdbIds = new Set(itemsToCreate.map((i) => i.tmdbId));
  const remainingSourceData = filteredSourceData.filter((s) =>
    remainingTmdbIds.has(s.tmdbId)
  );

  // Build a map of TVDB ID -> Sonarr folder name for TV shows
  const sonarrFolderNames = new Map<number, string>();
  for (const item of itemsToCreate) {
    if (item.mediaType === 'tv' && item.tvdbId) {
      const sonarrStatus = showsByTvdbId.get(item.tvdbId);
      if (sonarrStatus?.folderName) {
        sonarrFolderNames.set(item.tvdbId, sonarrStatus.folderName);
      }
    }
  }

  // Call the internal placeholder creation logic
  return createPlaceholders(
    itemsToCreate,
    remainingSourceData,
    config,
    plexClient,
    sonarrFolderNames
  );
}

/**
 * Get effective released days from config (with backward compatibility)
 */
export function getReleasedDays(config: CollectionConfig): number {
  return config.placeholderReleasedDays || config.comingSoonReleasedDays || 7;
}

/**
 * Get effective days ahead from config (with backward compatibility)
 */
export function getDaysAhead(config: CollectionConfig): number {
  return config.placeholderDaysAhead || config.comingSoonDays || 360;
}

/**
 * Check if a collection config has placeholder creation enabled
 */
export function isPlaceholderCreationEnabled(
  config: CollectionConfig
): boolean {
  return config.createPlaceholdersForMissing === true;
}

/**
 * Convert MissingItem array to PlaceholderSourceData array
 * This allows any collection type to provide placeholder metadata
 */
function missingItemsToPlaceholderSourceData(
  missingItems: MissingItem[],
  requireReleaseDates = false
): PlaceholderSourceData[] {
  return missingItems
    .filter((item) => {
      // For normal collections, include all items
      if (!requireReleaseDates) {
        return true;
      }

      // For Coming Soon collections, only include items with release date info
      const hasReleaseDateInfo = !!(
        item.releaseDate ||
        item.digitalRelease ||
        item.physicalRelease ||
        item.airDate
      );
      return hasReleaseDateInfo;
    })
    .map((item) => ({
      tmdbId: item.tmdbId,
      tvdbId: item.tvdbId,
      title: item.title,
      year: item.year,
      releaseDate: item.releaseDate,
      digitalRelease: item.digitalRelease,
      physicalRelease: item.physicalRelease,
      inCinemas: item.inCinemas,
      airDate: item.airDate,
      mediaType: item.mediaType,
      source: item.source,
      monitored: item.monitored ?? false,
      isEstimatedDate: item.isEstimatedDate,
      seasonNumber: item.seasonNumber,
      episodeNumber: item.episodeNumber,
      // These will be calculated during placeholder creation
      releaseDateSortValue: undefined,
      releaseType: undefined,
      hasFile: false,
      isReturning: false,
    }));
}

/**
 * Create a single placeholder file without scanning or applying overlays
 * Returns the path to the created file
 */
/**
 * Create (or resume) a placeholder file. Tri-state on the computed destination:
 *  - (a) our own placeholder already on disk (size > 0, matching marker):
 *        RESUME - no download, no copy; return the path so discovery retries.
 *  - (b) a file exists with no matching Agregarr marker:
 *        REFUSE - never download over it, never manage it; return null (the
 *        caller skips it, so the unmatched-cleanup path can never delete a real
 *        user file that happens to sit at a computed placeholder path).
 *  - (c) our own zero-byte crashed copy: unlink and re-create.
 *  - (d) nothing there: normal download + create.
 *
 * Returns the placeholder path, or null when refusing to manage an existing
 * unmarked file.
 */
async function createPlaceholderFile(
  sourceItem: ComingSoonSourceData,
  libraryKey: string,
  sonarrFolderName?: string
): Promise<string | null> {
  const { getPlaceholderRootFolder } = await import(
    '@server/lib/placeholders/helpers/placeholderPathHelpers'
  );

  // Resolve the destination FIRST - a misconfigured root must fail before we
  // spend a YouTube search + yt-dlp on a trailer we cannot place.
  const libraryPath = getPlaceholderRootFolder(
    libraryKey,
    sourceItem.mediaType
  );

  if (!libraryPath) {
    // Get library name for better error message
    const settings = getSettings();
    const library = settings.plex.libraries?.find(
      (lib: Library) => lib.key === libraryKey
    );
    const libraryName = library?.name || `Library ${libraryKey}`;
    const mediaTypeLabel = sourceItem.mediaType === 'movie' ? 'Movie' : 'TV';

    throw new Error(
      `${mediaTypeLabel} placeholder root folder not configured for "${libraryName}". Please configure it in Settings > Downloads > ${mediaTypeLabel} Placeholder Folders.`
    );
  }

  const {
    createPlaceholder,
    resolvePlaceholderPaths,
    readPlaceholderMarker,
    clearMarkerOrphaned,
  } = await import('@server/lib/placeholders/placeholderManager');
  const { markPlaceholderWanted } = await import(
    '@server/lib/placeholders/services/PlaceholderCleanup'
  );
  const fs = await import('fs/promises');

  // Single source of truth for the computed destination (shared with the
  // creators), so "where we look" can never drift from "where we write".
  const { destinationPath } = resolvePlaceholderPaths({
    tmdbId: sourceItem.tmdbId,
    tvdbId: sourceItem.tvdbId,
    title: sourceItem.title,
    year: sourceItem.year,
    mediaType: sourceItem.mediaType,
    libraryPath,
    sonarrFolderName,
  });
  const markerDir = path.dirname(destinationPath);
  const relativePath = path.relative(libraryPath, destinationPath);

  let existingSize: number | null = null;
  try {
    existingSize = (await fs.stat(destinationPath)).size;
  } catch {
    existingSize = null; // ENOENT (or unreadable) -> normal creation flow (d)
  }

  if (existingSize !== null) {
    const marker = await readPlaceholderMarker(markerDir);
    const markerMatches =
      marker !== null &&
      (marker.tmdbId === undefined || marker.tmdbId === sourceItem.tmdbId);

    if (existingSize > 0 && markerMatches) {
      // (a) RESUME
      let ageDays: number | undefined;
      if (marker?.createdAt) {
        const created = new Date(marker.createdAt).getTime();
        if (!Number.isNaN(created)) {
          ageDays = Math.floor((Date.now() - created) / (24 * 60 * 60 * 1000));
        }
      }
      logger.info(
        'Placeholder already on disk - skipping trailer download, awaiting Plex discovery',
        {
          label: 'PlaceholderService',
          title: sourceItem.title,
          tmdbId: sourceItem.tmdbId,
          mediaType: sourceItem.mediaType,
          path: destinationPath,
          ageDays,
        }
      );
      // Proof the item is still wanted: clear any orphan stamp and keep the
      // sweep off it this run (so it can never age out or re-download).
      await clearMarkerOrphaned(markerDir);
      markPlaceholderWanted(libraryKey, sourceItem.mediaType, relativePath);
      return destinationPath;
    }

    if (existingSize === 0 && markerMatches) {
      // (c) our own crashed zero-byte copy: remove it and fall through to a
      // clean re-create (keeps COPYFILE_EXCL unconditional).
      try {
        await fs.unlink(destinationPath);
      } catch {
        // best-effort; the EXCL copy below surfaces any genuine problem
      }
    } else {
      // (b) REFUSE-TO-MANAGE: an unmarked file (or a marker for a different
      // tmdbId) sits at the computed path. Do not download over it, adopt it,
      // or add it to createdPlaceholders.
      logger.warn(
        'File exists at computed placeholder path without a matching Agregarr marker - not downloading, not overwriting, not managing',
        {
          label: 'PlaceholderService',
          title: sourceItem.title,
          tmdbId: sourceItem.tmdbId,
          mediaType: sourceItem.mediaType,
          path: destinationPath,
        }
      );
      return null;
    }
  }

  // (d) Normal flow: download the trailer, then create the placeholder.
  const { downloadTrailer } = await import(
    '@server/lib/placeholders/trailerDownload'
  );
  const trailerPath = await downloadTrailer(
    sourceItem.title,
    sourceItem.year,
    sourceItem.mediaType,
    sourceItem.tmdbId
  );

  logger.debug(
    `Using configured ${sourceItem.mediaType} root folder for placeholder creation`,
    {
      label: 'PlaceholderService',
      libraryKey,
      rootFolder: libraryPath,
    }
  );

  const result = await createPlaceholder({
    tmdbId: sourceItem.tmdbId,
    tvdbId: sourceItem.tvdbId,
    title: sourceItem.title,
    year: sourceItem.year,
    mediaType: sourceItem.mediaType,
    libraryPath,
    trailerPath,
    sonarrFolderName,
  });

  markPlaceholderWanted(libraryKey, sourceItem.mediaType, relativePath);
  return result.placeholderPath;
}

/**
 * Quarantine placeholders that were created THIS run but never appeared in
 * Plex during the discovery poll.
 *
 * These files are provably ours (we just created them), yet Plex never
 * indexed them - which is exactly the unproven-#0b case: a scoped
 * `refresh?path=` on a brand-new folder may not index it. Deleting them here
 * (the old behaviour) produced a create -> undiscovered -> delete -> recreate
 * churn loop on every sync. So we DO NOT delete: the file stays on disk and
 * discovery is re-attempted on the next sync. This is what makes the
 * scoped-scan change churn-safe REGARDLESS of the #0b result - the guard, not
 * #0b, provides the safety; #0b only decides how fast discovery succeeds.
 *
 * Self-heal: the moment Plex indexes the folder (via the scoped scan, its
 * "partial scan on change" folder watcher, or a later full maintenance scan),
 * the next sync's orphan-adoption scan finds the item and adopts it (it
 * carries a `.comingsoon` marker), creating the DB record. No re-download in
 * that path.
 *
 * Deliberately NOT negative-cached (recordUnmatchedPlaceholder): caching would
 * suppress the re-attempt for the TTL window. We want each subsequent sync to
 * retry discovery until it self-heals. The only cost while a folder stays
 * unindexed is a re-copied trailer per sync, which stops as soon as the item
 * is indexed and no longer reported missing. Never data loss, never a
 * delete/recreate loop.
 */
async function quarantineUndiscoveredPlaceholders(
  placeholders: {
    sourceItem: ComingSoonSourceData;
    placeholderPath: string;
  }[],
  config: CollectionConfig
): Promise<void> {
  if (placeholders.length === 0) {
    return;
  }

  for (const { sourceItem, placeholderPath } of placeholders) {
    // One diagnosable line per stuck item so a user whose folder never
    // indexes is debuggable from the logs.
    logger.warn(
      'Placeholder still awaiting Plex discovery - keeping file on disk, will retry next sync (not deleted)',
      {
        label: 'PlaceholderService',
        title: sourceItem.title,
        tmdbId: sourceItem.tmdbId,
        mediaType: sourceItem.mediaType,
        placeholderPath,
        libraryId: config.libraryId,
      }
    );
  }
}

/**
 * Self-heal: write the `.comingsoon` marker for a DB-tracked placeholder that
 * is missing it on disk (e.g. a movie placeholder created before movie
 * markers existed). A `coming_soon_item` DB record is PROOF of Agregarr
 * ownership, so this is safe and non-destructive: it only ever creates an
 * absent marker (flag 'wx' never clobbers an existing one) and never touches
 * media. Making ownership consistently identifiable lets the marker gate and
 * the normal grace-period cleanup manage the placeholder. Ownership is NEVER
 * inferred from filename tokens here - only the DB record authorises a
 * back-fill, which is the exact false-positive path being guarded against.
 *
 * The marker lives beside the placeholder file for both media types (movie:
 * the movie folder; tv: Season 00), i.e. dirname(placeholderPath).
 */
export async function backfillPlaceholderMarker(record: {
  configId: string;
  placeholderPath: string;
  title: string;
  year?: number;
  tmdbId: number;
  tvdbId?: number;
  mediaType: 'movie' | 'tv';
}): Promise<boolean> {
  // Resolve the placeholder's ABSOLUTE path from the record's OWN config root.
  // The stored path is relative; the previous code wrote the marker beside a
  // path resolved against cwd, so writeFile ENOENT'd and the back-fill was dead
  // code. rootOf handles multi-source (-source-N) IDs and legacy array
  // libraryId; resolveRecordPath handles legacy absolute rows (no double-join).
  const { resolveRecordPath } = await import(
    '@server/lib/placeholders/placeholderManager'
  );
  const { rootOf } = await import(
    '@server/lib/placeholders/services/PlaceholderCleanup'
  );
  const root = rootOf(record.configId, record.mediaType);
  if (!root) {
    logger.debug('Cannot back-fill marker - no placeholder root for config', {
      label: 'PlaceholderService',
      title: record.title,
      tmdbId: record.tmdbId,
      configId: record.configId,
    });
    return false;
  }
  const abs = resolveRecordPath(root, record.placeholderPath);
  const markerPath = path.join(path.dirname(abs), '.comingsoon');

  const fs = await import('fs/promises');
  // Access-first gate: only back-fill when the placeholder file is actually
  // present under this root (steady state = one stat per adopted record/sync;
  // also avoids writing an orphan marker beside a non-existent file).
  try {
    await fs.access(abs);
  } catch {
    return false;
  }
  try {
    await fs.access(markerPath);
    return false; // marker already present
  } catch {
    // absent - back-fill below
  }

  try {
    // 'wx' (create-only, never clobber). Deliberately NOT writeMarkerAtomic:
    // rename would overwrite a manual marker; the create-only contract is the
    // point.
    await fs.writeFile(
      markerPath,
      JSON.stringify({
        createdAt: new Date().toISOString(),
        title: record.title,
        year: record.year,
        tmdbId: record.tmdbId,
        tvdbId: record.tvdbId,
        backfilled: true,
      }),
      { encoding: 'utf-8', flag: 'wx' }
    );
    logger.info(
      'Back-filled missing .comingsoon marker for DB-tracked placeholder',
      {
        label: 'PlaceholderService',
        title: record.title,
        tmdbId: record.tmdbId,
        markerPath,
      }
    );
    return true;
  } catch (error) {
    const alreadyExists =
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'EEXIST';
    if (!alreadyExists) {
      // Directory gone or unwritable - non-fatal, will retry next sync.
      logger.debug('Could not back-fill .comingsoon marker', {
        label: 'PlaceholderService',
        title: record.title,
        tmdbId: record.tmdbId,
        markerPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return false;
  }
}

/**
 * Handle unmatched placeholders - search by title and cleanup if truly unmatched
 * This is a fallback for when Plex doesn't match items with TMDB metadata
 * Optimized: Deletes all unmatched files immediately and triggers ONE cleanup scan at the end
 */
async function handleUnmatchedPlaceholders(
  unmatchedItems: ComingSoonSourceData[],
  config: CollectionConfig,
  plexClient: PlexAPI,
  discovered: Map<number, { ratingKey: string; title: string }>,
  excludedUnmatched: Set<number>,
  placeholderPathMap: Map<number, string>
): Promise<void> {
  const { removePlaceholder } = await import(
    '@server/lib/placeholders/placeholderManager'
  );

  logger.info('Attempting title-based search for unmatched items', {
    label: 'PlaceholderService',
    unmatchedCount: unmatchedItems.length,
  });

  const filesToDelete: {
    path: string;
    mediaType: 'movie' | 'tv';
    title: string;
    tmdbId: number;
  }[] = [];

  // First pass: Check all items and collect files to delete
  for (const item of unmatchedItems) {
    try {
      // Search Plex by title
      const titleMatches = await findPlexItemsByTitle(
        plexClient,
        item.title,
        item.year,
        config.libraryId,
        item.mediaType
      );

      if (titleMatches.length === 0) {
        // Not found in Plex at all - likely still scanning or failed to create
        logger.debug('No title matches found in Plex', {
          label: 'PlaceholderService',
          title: item.title,
          year: item.year,
          tmdbId: item.tmdbId,
        });
        continue;
      }

      // Accept a late match only when the external ids line up with the item
      // we created. Title overlap alone matched wrong shows before
      // (e.g. "World War II: From the Frontlines" -> "FROM"). TVDB counts too:
      // Plex may match a show by TVDB without exposing a TMDB guid.
      const exactMatch = titleMatches.find(
        (m) =>
          m.tmdbId === item.tmdbId ||
          (item.tvdbId !== undefined &&
            m.tvdbId !== undefined &&
            m.tvdbId === item.tvdbId)
      );

      if (exactMatch) {
        logger.info(
          'Found item by title with matching external id - adding to discovered (late match)',
          {
            label: 'PlaceholderService',
            title: item.title,
            tmdbId: item.tmdbId,
            plexTitle: exactMatch.title,
            ratingKey: exactMatch.ratingKey,
          }
        );

        discovered.set(item.tmdbId, {
          ratingKey: exactMatch.ratingKey,
          title: exactMatch.title,
        });
        continue;
      }

      // Check if any matches are unmatched in Plex (no TMDB guid)
      const unmatchedInPlex = titleMatches.filter(
        (match) => !match.hasTmdbGuid
      );

      if (unmatchedInPlex.length > 0) {
        // Found the placeholder in Plex, but it's unmatched - schedule for deletion
        const match = unmatchedInPlex[0];
        const placeholderPath = placeholderPathMap.get(item.tmdbId);

        if (!placeholderPath) {
          logger.warn('No placeholder path found for unmatched item', {
            label: 'PlaceholderService',
            title: item.title,
            tmdbId: item.tmdbId,
          });
          continue;
        }

        logger.warn(
          'Placeholder found in Plex but unmatched (no TMDB guid) - scheduling for deletion',
          {
            label: 'PlaceholderService',
            title: item.title,
            year: item.year,
            tmdbId: item.tmdbId,
            plexTitle: match.title,
            plexYear: match.year,
            placeholderPath,
          }
        );

        filesToDelete.push({
          path: placeholderPath,
          mediaType: item.mediaType,
          title: item.title,
          tmdbId: item.tmdbId,
        });
      } else {
        // Matches exist with TMDB guids, but none belong to our item - it's a
        // different show that overlaps on title. Leave for poll cleanup.
        logger.debug(
          'Title matches found but none with the requested external ids - leaving for poll cleanup',
          {
            label: 'PlaceholderService',
            title: item.title,
            tmdbId: item.tmdbId,
            matchTmdbIds: titleMatches.map((m) => m.tmdbId),
          }
        );
      }
    } catch (error) {
      logger.error('Error during title-based search for unmatched item', {
        label: 'PlaceholderService',
        title: item.title,
        tmdbId: item.tmdbId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Second pass: Delete all unmatched files immediately
  if (filesToDelete.length > 0) {
    logger.info(
      `Deleting ${filesToDelete.length} unmatched placeholder files`,
      {
        label: 'PlaceholderService',
        fileCount: filesToDelete.length,
      }
    );

    let deletedCount = 0;
    const ghostDeletions: GhostDeletion[] = [];
    for (const file of filesToDelete) {
      try {
        // created-this-run: these paths flow only from createPlaceholderFile
        // return values within this run, and the tri-state guarantees each is a
        // freshly-created or marker-verified placeholder (a refused real file
        // returns null and never enters filesToDelete).
        await removePlaceholder(file.path, file.mediaType, {
          source: 'created-this-run',
        });
        excludedUnmatched.add(file.tmdbId);
        deletedCount++;
        // Enqueue the file itself; the Sink-2 gate resolves the ghost Plex
        // entry and refuses to touch any real/merged item.
        ghostDeletions.push({
          filePath: file.path,
          mediaType: file.mediaType,
        });

        await recordUnmatchedPlaceholder(config.libraryId, {
          tmdbId: file.tmdbId,
          mediaType: file.mediaType,
          title: file.title,
        });

        logger.debug('Deleted unmatched placeholder file', {
          label: 'PlaceholderService',
          title: file.title,
          path: file.path,
        });
      } catch (deleteError) {
        logger.error('Failed to delete unmatched placeholder file', {
          label: 'PlaceholderService',
          title: file.title,
          path: file.path,
          error:
            deleteError instanceof Error
              ? deleteError.message
              : String(deleteError),
        });
      }
    }

    // Trigger ONE cleanup scan after all deletions
    if (deletedCount > 0) {
      logger.info(
        `Triggering single cleanup scan after deleting ${deletedCount} unmatched placeholders`,
        {
          label: 'PlaceholderService',
          libraryId: config.libraryId,
          deletedCount,
        }
      );

      try {
        const { removeGhostEntries } = await import(
          '@server/lib/placeholders/services/PlaceholderCleanup'
        );
        await removeGhostEntries(plexClient, config.libraryId, ghostDeletions);
      } catch (error) {
        logger.error('Failed to trigger cleanup scan after deletions', {
          label: 'PlaceholderService',
          libraryId: config.libraryId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  logger.info('Title-based fallback search completed', {
    label: 'PlaceholderService',
    totalProcessed: unmatchedItems.length,
    filesDeleted: filesToDelete.length,
    lateMatches: discovered.size,
    excluded: excludedUnmatched.size,
  });
}

/**
 * Wait for Plex to discover multiple items after a library scan
 */
async function waitForPlexDiscovery(
  placeholders: {
    sourceItem: ComingSoonSourceData;
    placeholderPath: string;
  }[],
  config: CollectionConfig,
  plexClient: PlexAPI
): Promise<{
  discovered: Map<number, { ratingKey: string; title: string }>;
  excludedUnmatched: Set<number>;
}> {
  const sourceItems = placeholders.map((p) => p.sourceItem);
  const discovered = new Map<number, { ratingKey: string; title: string }>();
  const excludedUnmatched = new Set<number>(); // Track items found by title but unmatched

  // Calculate max attempts based on item count
  // Base: 5 minutes (30 attempts), plus 2 seconds per item beyond 50
  const baseAttempts = 30;
  const itemCount = placeholders.length;
  const extraSeconds = Math.max(0, (itemCount - 50) * 2); // 2 seconds per item for large batches
  const extraAttempts = Math.ceil(extraSeconds / 10); // Convert to 10-second intervals
  const maxAttempts = baseAttempts + extraAttempts; // No cap - let the calculation determine timeout
  const pollInterval = 10000; // 10 seconds

  // Build a map of tmdbId -> placeholderPath for cleanup
  const placeholderPathMap = new Map<number, string>();
  for (const { sourceItem, placeholderPath } of placeholders) {
    placeholderPathMap.set(sourceItem.tmdbId, placeholderPath);
  }

  // Track when items stop appearing
  let itemsStartedAppearing = false;
  let consecutiveNoDiscovery = 0; // Count of consecutive polls with no new discoveries
  const minTimeBeforeFallback = 60000; // 60 seconds (6 attempts) - optimized for faster detection
  const waitCyclesAfterStop = 2; // Wait 2 more cycles after items stop appearing

  logger.info('Polling Plex for placeholder discovery', {
    label: 'PlaceholderService',
    itemCount: sourceItems.length,
  });

  // Wait 10 seconds before first check to give Plex auto-detection a chance to work
  await new Promise((resolve) => setTimeout(resolve, 10000));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const previousSize = discovered.size;

    // Build lookup array for items we haven't found yet (excluding already excluded unmatched items)
    const stillMissing = sourceItems.filter(
      (item) =>
        !discovered.has(item.tmdbId) && !excludedUnmatched.has(item.tmdbId)
    );

    if (stillMissing.length === 0) {
      logger.info('All placeholders discovered by Plex', {
        label: 'PlaceholderService',
        attempt,
        totalItems: sourceItems.length,
        excludedUnmatched: excludedUnmatched.size,
      });
      break;
    }

    const tmdbLookups = stillMissing.map((item) => ({
      tmdbId: item.tmdbId,
      mediaType: item.mediaType,
      title: item.title,
    }));

    // Check if Plex has discovered the items by TMDB ID
    const itemMap = await findPlexItemsByTmdbIds(
      plexClient,
      tmdbLookups,
      config.libraryId
    );

    logger.debug('Poll attempt results', {
      label: 'PlaceholderService',
      attempt,
      itemMapSize: itemMap.size,
      itemMapKeys: Array.from(itemMap.keys()),
      lookingFor: stillMissing.map((i) => ({
        tmdbId: i.tmdbId,
        title: i.title,
      })),
    });

    // Add newly discovered items
    for (const item of stillMissing) {
      // The key format is: tmdbId-mediaType (e.g., "66732-tv")
      const tmdbKey = `${item.tmdbId}-${item.mediaType}`;
      const plexItem = itemMap.get(tmdbKey);
      if (plexItem) {
        discovered.set(item.tmdbId, plexItem);
        logger.debug('Plex discovered placeholder', {
          label: 'PlaceholderService',
          title: item.title,
          attempt,
        });
      } else {
        logger.debug('Item not found in map', {
          label: 'PlaceholderService',
          title: item.title,
          tmdbKey,
          attempt,
        });
      }
    }

    // Track discovery progress
    if (discovered.size > previousSize) {
      // New items were discovered
      if (!itemsStartedAppearing) {
        itemsStartedAppearing = true;
        logger.info('Items started appearing in Plex', {
          label: 'PlaceholderService',
          attempt,
          elapsed: attempt * 10,
        });
      }
      consecutiveNoDiscovery = 0; // Reset counter
    } else if (itemsStartedAppearing) {
      // No new items found, and items had started appearing before
      consecutiveNoDiscovery++;
      logger.debug('No new discoveries this cycle', {
        label: 'PlaceholderService',
        attempt,
        consecutiveNoDiscovery,
      });
    }

    // Check if all found or need to continue
    if (discovered.size === sourceItems.length) {
      logger.info('All placeholders discovered by Plex', {
        label: 'PlaceholderService',
        attempt,
        totalItems: sourceItems.length,
      });
      break;
    }

    // Title-based fallback logic
    // After items have been appearing for at least 60 seconds (6 attempts)
    // AND items have stopped appearing for 1 consecutive cycle (10 seconds)
    const elapsedTime = attempt * pollInterval;
    const shouldAttemptFallback =
      itemsStartedAppearing &&
      elapsedTime >= minTimeBeforeFallback &&
      consecutiveNoDiscovery >= waitCyclesAfterStop;

    if (shouldAttemptFallback && stillMissing.length > 0) {
      logger.info(
        'Items stopped appearing - attempting title-based fallback search and cleanup for unmatched placeholders',
        {
          label: 'PlaceholderService',
          attempt,
          elapsed: elapsedTime / 1000,
          stillMissingCount: stillMissing.length,
          consecutiveNoDiscovery,
        }
      );

      // Attempt title-based search and immediate cleanup for unmatched items
      await handleUnmatchedPlaceholders(
        stillMissing,
        config,
        plexClient,
        discovered,
        excludedUnmatched,
        placeholderPathMap
      );

      // After fallback, break immediately - remaining items won't match
      logger.info('Title-based fallback completed - ending discovery', {
        label: 'PlaceholderService',
        attempt,
        totalItems: sourceItems.length,
        discovered: discovered.size,
        excludedUnmatched: excludedUnmatched.size,
        remainingUnmatched: stillMissing.length - excludedUnmatched.size,
      });
      break;
    }

    // Wait before next check (except on last attempt)
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  if (discovered.size + excludedUnmatched.size < sourceItems.length) {
    logger.warn('Some placeholders were not resolved by Plex after polling', {
      label: 'PlaceholderService',
      totalItems: sourceItems.length,
      discovered: discovered.size,
      excludedUnmatched: excludedUnmatched.size,
      missing: sourceItems.length - discovered.size - excludedUnmatched.size,
    });
  }

  return { discovered, excludedUnmatched };
}

/**
 * Verify that discovered placeholders have posters in Plex
 * If Plex has no poster but TMDB does, apply the TMDB poster directly
 */
async function verifyPlexPosters(
  discovered: Map<number, { ratingKey: string; title: string }>,
  config: CollectionConfig,
  plexClient: PlexAPI,
  placeholderPathMap: Map<number, string>,
  sourceMap: Map<number, ComingSoonSourceData>
): Promise<Map<number, { ratingKey: string; title: string }>> {
  const TmdbAPI = (await import('@server/api/themoviedb')).default;
  const tmdbClient = new TmdbAPI();

  let postersApplied = 0;
  let postersAlreadyPresent = 0;

  logger.info('Verifying Plex posters for discovered placeholders', {
    label: 'PlaceholderService',
    itemCount: discovered.size,
  });

  // Check each discovered item for poster
  for (const [tmdbId, plexItem] of discovered) {
    try {
      const metadata = await plexClient.getMetadata(plexItem.ratingKey);

      if (!metadata.thumb) {
        const sourceItem = sourceMap.get(tmdbId);

        if (sourceItem) {
          logger.info(
            'Placeholder has no poster in Plex - applying TMDB poster',
            {
              label: 'PlaceholderService',
              title: plexItem.title,
              tmdbId,
              ratingKey: plexItem.ratingKey,
              mediaType: sourceItem.mediaType,
            }
          );

          // Fetch TMDB poster URL
          let posterPath: string | undefined;

          if (sourceItem.mediaType === 'movie') {
            const movieDetails = await tmdbClient.getMovie({
              movieId: tmdbId,
            });
            posterPath = movieDetails.poster_path;
          } else {
            const showDetails = await tmdbClient.getTvShow({
              tvId: tmdbId,
            });
            posterPath = showDetails.poster_path;
          }

          if (posterPath) {
            const tmdbPosterUrl = `https://image.tmdb.org/t/p/original${posterPath}`;

            // Apply TMDB poster to Plex item
            const posterManager = plexClient['posterManager'];
            await posterManager.uploadPosterFromUrl(
              plexItem.ratingKey,
              tmdbPosterUrl
            );

            postersApplied++;

            logger.info('Successfully applied TMDB poster to placeholder', {
              label: 'PlaceholderService',
              title: plexItem.title,
              tmdbId,
              ratingKey: plexItem.ratingKey,
            });
          } else {
            // This shouldn't happen since we pre-filter for TMDB posters,
            // but log it just in case
            logger.warn(
              'TMDB has no poster for item (unexpected - pre-filter should have caught this)',
              {
                label: 'PlaceholderService',
                title: plexItem.title,
                tmdbId,
                mediaType: sourceItem.mediaType,
              }
            );
          }
        }
      } else {
        postersAlreadyPresent++;
      }
    } catch (error) {
      logger.error('Failed to verify/apply poster', {
        label: 'PlaceholderService',
        title: plexItem.title,
        tmdbId,
        ratingKey: plexItem.ratingKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info('Poster verification complete', {
    label: 'PlaceholderService',
    totalChecked: discovered.size,
    postersAlreadyPresent,
    postersApplied,
  });

  return discovered;
}

/**
 * Trigger directory-scoped Plex scans for newly created placeholder files.
 *
 * Scans only the folders that received new placeholders instead of the whole
 * library, so unrelated unavailable items (e.g. from a network mount that
 * dropped mid-sync) can't be marked missing and purged by servers with
 * "Empty trash automatically after every scan" enabled. Mirrors the
 * removeGhostEntries pattern in PlaceholderCleanup.ts, minus its emptyTrash
 * logic - this path must never touch the trash.
 *
 * #0b live test only decides discovery QUALITY, not safety: scoped
 * `refresh?path=` is proven to re-index existing/emptied folders (3e79245),
 * but indexing a BRAND-NEW folder is unconfirmed. Safety does NOT depend on
 * that result - quarantineUndiscoveredPlaceholders never deletes a
 * just-created placeholder that fails to appear, so the worst case if #0b
 * fails is a placeholder that sits on disk and retries discovery each sync
 * until Plex's "partial scan on change" folder watcher (or a later scan)
 * indexes it. There is no create/delete/recreate churn and no data loss
 * regardless of the #0b outcome; a passing #0b test just makes discovery
 * immediate instead of watcher-latency-bound.
 *
 * Deliberately never falls back to a full library scan (that is the
 * mass-purge risk this change removes). When a folder can't be scoped-scanned
 * (outside the section paths as Plex sees them, or the refresh call fails),
 * the Plex folder watcher is the remaining discovery path and the quarantine
 * guard keeps the file safe in the meantime.
 */
async function scanNewPlaceholderDirectories(
  plexClient: PlexAPI,
  libraryId: string,
  createdPlaceholders: {
    sourceItem: ComingSoonSourceData;
    placeholderPath: string;
  }[]
): Promise<void> {
  // TV placeholder files live in <show>/Season 00/ - scan the show folder so
  // the brand-new show directory itself gets indexed. Movie placeholders sit
  // directly in the movie folder.
  const directories = createdPlaceholders.map(
    ({ sourceItem, placeholderPath }) =>
      sourceItem.mediaType === 'tv'
        ? path.dirname(path.dirname(placeholderPath))
        : path.dirname(placeholderPath)
  );
  const uniqueDirectories = [...new Set(directories)];
  if (uniqueDirectories.length === 0) {
    return;
  }

  // A directory only produces a useful scoped scan if Plex can resolve it,
  // i.e. it sits strictly below one of the section's configured locations.
  // Placeholder roots are assumed to be mounted identically in Agregarr and
  // Plex - the same assumption removeGhostEntries relies on.
  const sectionPaths = await plexClient.getLibrarySectionPaths(libraryId);
  const isInsideSection = (directory: string): boolean =>
    sectionPaths.length === 0 ||
    sectionPaths.some(
      (root) =>
        directory !== root &&
        directory.startsWith(root.endsWith('/') ? root : `${root}/`)
    );

  const scopedDirectories = uniqueDirectories.filter(isInsideSection);
  const outsideSection = uniqueDirectories.length - scopedDirectories.length;

  if (outsideSection > 0) {
    logger.warn(
      'Some new placeholder directories are outside the Plex section locations - relying on the Plex folder watcher instead of a full library scan (a full scan risks mass-purging real items on servers that auto-empty trash)',
      {
        label: 'PlaceholderService',
        libraryId,
        outsideSection,
        sectionPaths,
      }
    );
  }

  for (const directory of scopedDirectories) {
    try {
      await plexClient.scanLibrary(libraryId, directory);
    } catch (error) {
      logger.warn(
        'Scoped Plex scan failed for new placeholder directory - relying on the Plex folder watcher and discovery polling',
        {
          label: 'PlaceholderService',
          libraryId,
          directory,
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
  }
}

/**
 * Create placeholders for missing items
 * Strategy: Create ALL files first, then trigger scoped scans, then apply overlays
 * Returns the discovered placeholder items as CollectionItems
 */
async function createPlaceholders(
  missingItems: MissingItem[],
  sourceData: ComingSoonSourceData[],
  config: CollectionConfig,
  plexClient: PlexAPI,
  sonarrFolderNames?: Map<number, string>
): Promise<CollectionItem[]> {
  if (missingItems.length === 0) {
    return [];
  }

  logger.info('Creating placeholders for missing items', {
    label: 'PlaceholderService',
    count: missingItems.length,
  });

  const sourceMap = new Map(sourceData.map((s) => [s.tmdbId, s]));

  // Step 0: Pre-filter items - only create placeholders for items with posters available
  const TmdbAPI = (await import('@server/api/themoviedb')).default;
  const tmdbClient = new TmdbAPI();
  const itemsWithPosters: MissingItem[] = [];

  logger.info('Checking TMDB for poster availability', {
    label: 'PlaceholderService',
    count: missingItems.length,
  });

  for (const missingItem of missingItems) {
    const sourceItem = sourceMap.get(missingItem.tmdbId);
    if (!sourceItem) {
      continue;
    }

    try {
      let hasPoster = false;

      if (sourceItem.mediaType === 'movie') {
        const movieDetails = await tmdbClient.getMovie({
          movieId: sourceItem.tmdbId,
        });
        hasPoster = !!movieDetails.poster_path;
      } else {
        const showDetails = await tmdbClient.getTvShow({
          tvId: sourceItem.tmdbId,
        });
        hasPoster = !!showDetails.poster_path;
      }

      if (hasPoster) {
        itemsWithPosters.push(missingItem);
      } else {
        logger.info('Skipping placeholder creation - no poster available', {
          label: 'PlaceholderService',
          title: sourceItem.title,
          tmdbId: sourceItem.tmdbId,
          mediaType: sourceItem.mediaType,
        });
      }
    } catch (error) {
      logger.warn('Failed to check poster availability, skipping item', {
        label: 'PlaceholderService',
        title: sourceItem.title,
        tmdbId: sourceItem.tmdbId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (itemsWithPosters.length === 0) {
    logger.info(
      'No items with posters available, skipping placeholder creation',
      {
        label: 'PlaceholderService',
        originalCount: missingItems.length,
      }
    );
    return [];
  }

  logger.info('Creating placeholders for items with posters', {
    label: 'PlaceholderService',
    count: itemsWithPosters.length,
    skipped: missingItems.length - itemsWithPosters.length,
  });

  // Step 0.5: Check for existing orphaned placeholders in Plex and adopt them
  // This fixes placeholders that lost their database records
  const { placeholderContextService } = await import(
    '@server/lib/placeholders/services/PlaceholderContextService'
  );

  logger.info('Checking Plex for existing orphaned placeholders', {
    label: 'PlaceholderService',
    libraryId: config.libraryId,
  });

  // Get all items in the library
  const libraryItems = await plexClient.getLibraryContents(config.libraryId);
  const orphanedPlaceholders: {
    sourceItem: ComingSoonSourceData;
    plexItem: { ratingKey: string; title: string };
    placeholderPath: string;
  }[] = [];
  let deletedOrphanCount = 0;

  // Get ALL existing database records to check for orphans
  // CRITICAL: Must query ALL records, not just current config, to avoid deleting
  // placeholders that belong to other collections
  const placeholderRepository = getRepository(ComingSoonItem);
  const existingRecords = await placeholderRepository.find();
  const existingByTmdbId = new Map(existingRecords.map((r) => [r.tmdbId, r]));

  // Deletion safety: this scan only knows the CURRENT config's source items,
  // so a record-less placeholder that isn't in sourceMap may still belong to
  // another placeholder-enabled config (whose source can't be enumerated
  // without running its sync). Count the other configs that could own
  // placeholders visible in this library's placeholder roots - deletion is
  // only allowed when this config is provably the sole possible owner.
  const { getPlaceholderRootFolder } = await import(
    '@server/lib/placeholders/helpers/placeholderPathHelpers'
  );
  const allCollectionConfigs = getSettings().plex.collectionConfigs || [];
  // config.libraryId can legacy-be an array - normalise both sides.
  const currentLibraries = Array.isArray(config.libraryId)
    ? config.libraryId
    : [config.libraryId];

  // Normalise a root path for comparison: unify separators, strip a trailing
  // separator, lower-case. Case-insensitivity is the FAIL-CLOSED direction
  // here - it can only make two roots look more alike, which can only ADD
  // possible owners and therefore SKIP more deletions, never delete more.
  // Best-effort against bind-mount / SMB case-fold aliases; a
  // symlink alias that shares no textual prefix still can't be caught here,
  // but the on-disk `.comingsoon` marker gate is the real backstop.
  const normaliseRoot = (root: string): string =>
    root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

  const pathsOverlap = (a: string, b: string): boolean =>
    a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

  const countOtherPossibleOwners = (mediaType: 'movie' | 'tv'): number => {
    const currentRoots = currentLibraries
      .map((library) => getPlaceholderRootFolder(library, mediaType))
      .filter((root): root is string => !!root)
      .map(normaliseRoot);

    // Fail closed: if we cannot resolve ANY placeholder root for the current
    // config (e.g. array-shaped libraryId, misconfig), we cannot prove sole
    // ownership - treat as if another owner exists so deletion is skipped.
    if (currentRoots.length === 0) {
      return 1;
    }

    return allCollectionConfigs.filter((other) => {
      if (other.id === config.id) {
        return false;
      }
      // Intentional: we do NOT also require other.isActive. An inactive but
      // placeholder-flagged config still counts as a possible owner, so a
      // record-less orphan it owns is left alone rather than deleted. Safe
      // re: data loss (it only leaks disk, never deletes); the alternative
      // (ignoring inactive configs) could delete a real co-owned placeholder.
      if (other.createPlaceholdersForMissing !== true) {
        return false;
      }
      const otherLibraries = Array.isArray(other.libraryId)
        ? other.libraryId
        : [other.libraryId];
      // Shares one of this scan's libraries directly.
      if (
        otherLibraries.some((library) => currentLibraries.includes(library))
      ) {
        return true;
      }
      // A config on another library can still own placeholders visible in
      // this scan when its placeholder root overlaps one of ours (equal,
      // ancestor, or descendant).
      return otherLibraries.some((library) => {
        const otherRoot = getPlaceholderRootFolder(library, mediaType);
        if (!otherRoot) {
          return false;
        }
        const normalisedOther = normaliseRoot(otherRoot);
        return currentRoots.some((root) => pathsOverlap(root, normalisedOther));
      });
    }).length;
  };
  const otherPossibleOwnerCounts = {
    movie: countOtherPossibleOwners('movie'),
    tv: countOtherPossibleOwners('tv'),
  };

  // Check each library item to see if it's an orphaned placeholder
  for (const item of libraryItems.items) {
    // Check if this is a placeholder using PlaceholderContextService
    const itemExtended = item as {
      type: string;
      guid?: string;
      editionTitle?: string;
      Guid?: { id: string }[];
      childCount?: number;
      Children?: { Metadata?: unknown[]; Directory?: unknown[] };
      seasonCount?: number;
      leafCount?: number;
    };

    const isPlaceholder =
      await placeholderContextService.isPlaceholderItemAsync(
        {
          type: itemExtended.type,
          guid: itemExtended.guid,
          editionTitle: itemExtended.editionTitle,
          Guid: itemExtended.Guid,
          childCount: itemExtended.childCount,
          Children: itemExtended.Children,
          seasonCount: itemExtended.seasonCount,
          leafCount: itemExtended.leafCount,
          ratingKey: item.ratingKey,
        },
        plexClient['plexClient'] as {
          query: (path: string) => Promise<{
            MediaContainer?: {
              Directory?: unknown[];
              Metadata?: unknown[];
            };
          }>;
        }
      );

    if (!isPlaceholder) {
      continue;
    }

    // For TV placeholders, ensure episode title is correct
    if (itemExtended.type === 'show') {
      await ensurePlaceholderEpisodeTitle(
        plexClient,
        item.ratingKey,
        item.title
      );
    }

    // Extract TMDB ID from Plex item
    let tmdbId: number | undefined;
    if (item.Guid && Array.isArray(item.Guid)) {
      const tmdbGuid = item.Guid.find((g: { id?: string }) =>
        g.id?.includes('tmdb://')
      );
      if (tmdbGuid) {
        const match = tmdbGuid.id.match(/tmdb:\/\/(\d+)/);
        if (match) {
          tmdbId = parseInt(match[1], 10);
        }
      }
    }

    if (!tmdbId) {
      continue;
    }

    // Check if it has a database record
    const hasRecord = existingByTmdbId.has(tmdbId);

    if (!hasRecord) {
      // Check if this placeholder is in our source data
      const sourceItem = sourceMap.get(tmdbId);
      if (!sourceItem) {
        const orphanMediaType: 'movie' | 'tv' =
          itemExtended.type === 'movie' ? 'movie' : 'tv';

        // Not in THIS config's source, but another placeholder-enabled
        // config's source may still contain it - deleting here would strand
        // that config's placeholder. Leave it for its owner's sync to adopt.
        const otherPossibleOwners = otherPossibleOwnerCounts[orphanMediaType];
        if (otherPossibleOwners > 0) {
          logger.info(
            'Found record-less placeholder not in this source - leaving it for other placeholder-enabled configs to adopt',
            {
              label: 'PlaceholderService',
              title: item.title,
              tmdbId,
              ratingKey: item.ratingKey,
              otherPossibleOwners,
            }
          );
          continue;
        }

        // Orphaned placeholder not in any placeholder-enabled config's
        // possible ownership - delete it
        logger.warn('Found orphaned placeholder - deleting immediately', {
          label: 'PlaceholderService',
          title: item.title,
          tmdbId,
          ratingKey: item.ratingKey,
        });

        // Get placeholder file path for deletion
        let placeholderPath = '';
        try {
          if (itemExtended.type === 'movie') {
            // Get movie file path
            const fullMetadata = await plexClient.getMetadata(item.ratingKey);
            if (fullMetadata.Media?.[0]?.Part?.[0]?.file) {
              placeholderPath = fullMetadata.Media[0].Part[0].file;
            }
          } else {
            // Get TV show file path from Season 00 Episode 01
            const fullMetadata = await plexClient.getMetadata(item.ratingKey);
            const seasons =
              fullMetadata.Children?.Metadata ||
              fullMetadata.Children?.Directory;
            const season00 = seasons?.find(
              (s: { index?: number }) => s.index === 0
            );

            if (season00 && 'ratingKey' in season00) {
              const seasonMetadata = await plexClient.getMetadata(
                String(season00.ratingKey)
              );
              const firstEpisode = (seasonMetadata.Children?.Metadata ||
                seasonMetadata.Children?.Directory)?.[0];

              if (firstEpisode && 'ratingKey' in firstEpisode) {
                const episodeMetadata = await plexClient.getMetadata(
                  String(firstEpisode.ratingKey)
                );
                if (episodeMetadata.Media?.[0]?.Part?.[0]?.file) {
                  placeholderPath = episodeMetadata.Media[0].Part[0].file;
                }
              }
            }
          }

          // Delete placeholder file
          if (placeholderPath) {
            const { removePlaceholder } = await import(
              '@server/lib/placeholders/placeholderManager'
            );
            const libraryPath = getPlaceholderRootFolder(
              config.libraryId,
              orphanMediaType
            );

            if (libraryPath) {
              // Extract relative path from Plex path by taking last N parts
              // This works regardless of path separators (Windows \ vs Linux /)
              // and handles cases where Plex runs on different OS than Agregarr
              const pathParts = placeholderPath.split(/[/\\]/).filter((p) => p);

              let relativePath = '';
              if (itemExtended.type === 'movie') {
                // Movies: last 2 parts (folder + filename)
                relativePath = pathParts.slice(-2).join(path.sep);
              } else {
                // TV: last 3 parts (show folder + Season 00 + filename)
                relativePath = pathParts.slice(-3).join(path.sep);
              }

              const fullPath = path.join(libraryPath, relativePath);

              // Never delete on heuristic detection alone. `marker` ownership
              // makes the sink verify an Agregarr-authored `.comingsoon` marker
              // (+ matching tmdbId) inside itself and throw EOWNERSHIP if it
              // cannot prove authorship. This protects users whose placeholder
              // root is the same folder as their real media from
              // isPlaceholderItemAsync false positives.
              //
              // INTENTIONAL: a record-less AND marker-less orphan is left on
              // disk (EOWNERSHIP), never auto-deleted. We cannot prove
              // ownership, so any auto-delete would reintroduce the real-media
              // deletion risk. This only affects pre-existing or
              // externally-created placeholders; every placeholder created after
              // this ships carries a marker, and DB-tracked ones get theirs
              // back-filled above, so this untracked set is bounded and shrinks
              // over time. Absolutely no time-based auto-delete.
              try {
                await removePlaceholder(fullPath, orphanMediaType, {
                  source: 'marker',
                  expectedTmdbId: tmdbId,
                });
                deletedOrphanCount++;
                logger.info('Deleted orphaned placeholder file', {
                  label: 'PlaceholderService',
                  title: item.title,
                  path: relativePath,
                });
              } catch (ownershipError) {
                if (
                  (ownershipError as NodeJS.ErrnoException).code ===
                  'EOWNERSHIP'
                ) {
                  logger.warn(
                    'Skipping orphaned placeholder deletion - no positive placeholder marker on disk (item may be real media misdetected as a placeholder, or a legacy/externally-created placeholder we cannot prove we own)',
                    {
                      label: 'PlaceholderService',
                      title: item.title,
                      tmdbId,
                      path: fullPath,
                    }
                  );
                  continue;
                }
                // ENOENT / other: fall through to the outer catch (unchanged).
                throw ownershipError;
              }
            }
          }
        } catch (error) {
          const isFileAlreadyGone =
            error instanceof Error &&
            'code' in error &&
            (error as NodeJS.ErrnoException).code === 'ENOENT';

          if (isFileAlreadyGone) {
            deletedOrphanCount++;
            logger.debug(
              'Orphaned placeholder file already removed - skipping',
              {
                label: 'PlaceholderService',
                title: item.title,
                tmdbId,
              }
            );
          } else {
            logger.error('Failed to delete orphaned placeholder', {
              label: 'PlaceholderService',
              title: item.title,
              tmdbId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        continue; // Skip to next item - orphan has been deleted
      }
    } else {
      // Has database record = PROVEN Agregarr ownership. Self-heal: back-fill
      // the `.comingsoon` marker if it's missing on disk (e.g. a movie
      // placeholder created before movie markers existed). Non-destructive,
      // never clobbers an existing marker, keyed off the DB record - never
      // off filename tokens. Makes the placeholder consistently identifiable
      // so the marker gate and grace-period cleanup can manage it.
      const trackedRecord = existingByTmdbId.get(tmdbId);
      if (trackedRecord?.placeholderPath) {
        await backfillPlaceholderMarker(trackedRecord);
      }

      // Has database record - check if it's in our source
      const sourceItem = sourceMap.get(tmdbId);
      if (!sourceItem) {
        continue; // Already has DB record but not in our source - cleanup will handle it
      }
    }

    // Get sourceItem (either from original source or newly created for orphaned)
    const sourceItem = sourceMap.get(tmdbId);
    if (!sourceItem) {
      continue; // Shouldn't happen, but safety check
    }

    if (!hasRecord) {
      // This is an orphaned placeholder - it exists in Plex but has no database record
      logger.warn('Found orphaned placeholder in Plex - will adopt it', {
        label: 'PlaceholderService',
        title: item.title,
        tmdbId,
        ratingKey: item.ratingKey,
      });

      // Get the placeholder file path
      let placeholderPath = '';
      try {
        let plexFilePath = '';

        if (sourceItem.mediaType === 'movie') {
          // For movies, get file path directly from metadata
          const fullMetadata = await plexClient.getMetadata(item.ratingKey);

          if (
            fullMetadata.Media &&
            Array.isArray(fullMetadata.Media) &&
            fullMetadata.Media.length > 0
          ) {
            const media = fullMetadata.Media[0];
            if (
              media.Part &&
              Array.isArray(media.Part) &&
              media.Part.length > 0
            ) {
              plexFilePath = media.Part[0].file || '';
            }
          }
        } else {
          // For TV shows, we need to get an episode from Season 00
          // Show-level items don't have Media/Part, only episodes do
          const fullMetadata = await plexClient.getMetadata(item.ratingKey);

          // Get children (seasons) - Plex returns seasons as Directory, not Metadata
          const seasons =
            fullMetadata.Children?.Metadata || fullMetadata.Children?.Directory;
          if (!seasons) {
            logger.warn(
              'Could not extract file path - no Children.Metadata or Directory',
              {
                label: 'PlaceholderService',
                title: item.title,
                ratingKey: item.ratingKey,
              }
            );
            continue;
          }

          // Find Season 00
          const season00 = seasons.find(
            (s: { index?: number }) => s.index === 0
          );

          if (!season00 || !('ratingKey' in season00)) {
            logger.warn('Could not extract file path - no Season 00 found', {
              label: 'PlaceholderService',
              title: item.title,
              seasonCount: seasons.length,
            });
            continue;
          }

          // Get episodes from Season 00
          const seasonMetadata = await plexClient.getMetadata(
            String(season00.ratingKey)
          );

          const episodes =
            seasonMetadata.Children?.Metadata ||
            seasonMetadata.Children?.Directory;
          if (!episodes || episodes.length === 0) {
            logger.warn(
              'Could not extract file path - Season 00 has no episodes',
              {
                label: 'PlaceholderService',
                title: item.title,
                season00RatingKey: season00.ratingKey,
              }
            );
            continue;
          }

          const firstEpisode = episodes[0];

          if (!('ratingKey' in firstEpisode)) {
            logger.warn(
              'Could not extract file path - episode has no ratingKey',
              {
                label: 'PlaceholderService',
                title: item.title,
              }
            );
            continue;
          }

          // Get file path from episode
          const episodeMetadata = await plexClient.getMetadata(
            String(firstEpisode.ratingKey)
          );

          if (
            !episodeMetadata.Media ||
            !Array.isArray(episodeMetadata.Media) ||
            episodeMetadata.Media.length === 0
          ) {
            logger.warn('Could not extract file path - episode has no Media', {
              label: 'PlaceholderService',
              title: item.title,
              episodeRatingKey: firstEpisode.ratingKey,
            });
            continue;
          }

          const media = episodeMetadata.Media[0];
          if (
            !media.Part ||
            !Array.isArray(media.Part) ||
            media.Part.length === 0
          ) {
            logger.warn('Could not extract file path - media has no Part', {
              label: 'PlaceholderService',
              title: item.title,
            });
            continue;
          }

          plexFilePath = media.Part[0].file || '';
        }

        if (!plexFilePath) {
          logger.warn('Could not extract file path - file is empty', {
            label: 'PlaceholderService',
            title: item.title,
            mediaType: sourceItem.mediaType,
          });
          continue;
        }

        // Extract relative path from Plex full path
        // Plex path: /plex/mount/tv/ShowName (Year)/Season 00/file.mp4 (Unix)
        // Plex path: E:\data\media\series\ShowName (Year)\Season 00\file.mp4 (Windows)
        // We need: ShowName (Year)/Season 00/file.mp4

        // Normalize path separators - handle both Unix (/) and Windows (\)
        const normalizedPath = plexFilePath.replace(/\\/g, '/');
        const pathParts = normalizedPath.split('/').filter((p) => p);

        let relativePath = '';
        if (sourceItem.mediaType === 'movie') {
          // Movies: Take last 2 parts (folder + filename)
          relativePath = pathParts.slice(-2).join('/');
        } else {
          // TV: Take last 3 parts (show folder + Season 00 + filename)
          relativePath = pathParts.slice(-3).join('/');
        }

        if (!relativePath) {
          logger.warn('Could not extract relative path', {
            label: 'PlaceholderService',
            title: item.title,
            plexFilePath,
          });
          continue;
        }

        // Verify file exists in our library
        const { getPlaceholderRootFolder } = await import(
          '@server/lib/placeholders/helpers/placeholderPathHelpers'
        );
        const libraryPath = getPlaceholderRootFolder(
          config.libraryId,
          sourceItem.mediaType
        );

        if (!libraryPath) {
          logger.warn('Placeholder library path not configured', {
            label: 'PlaceholderService',
            title: item.title,
            mediaType: sourceItem.mediaType,
            libraryId: config.libraryId,
          });
          continue;
        }

        const fullPath = path.join(libraryPath, relativePath);

        // Check if file exists
        const fs = await import('fs/promises');
        try {
          await fs.access(fullPath);
          placeholderPath = relativePath; // Store relative path

          logger.debug('Found orphaned placeholder file', {
            label: 'PlaceholderService',
            title: item.title,
            relativePath,
          });
        } catch {
          logger.warn('Orphaned placeholder file not found at expected path', {
            label: 'PlaceholderService',
            title: item.title,
            expectedPath: fullPath,
          });
          continue;
        }
      } catch (error) {
        logger.warn('Failed to locate placeholder file for orphaned item', {
          label: 'PlaceholderService',
          title: item.title,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (placeholderPath) {
        orphanedPlaceholders.push({
          sourceItem,
          plexItem: { ratingKey: item.ratingKey, title: item.title },
          placeholderPath,
        });

        // Remove from itemsWithPosters so we don't try to create a duplicate
        const indexToRemove = itemsWithPosters.findIndex(
          (mi) => mi.tmdbId === tmdbId
        );
        if (indexToRemove !== -1) {
          itemsWithPosters.splice(indexToRemove, 1);
        }
      }
    }
  }

  if (deletedOrphanCount > 0) {
    logger.info('Deleted orphaned placeholders', {
      label: 'PlaceholderService',
      count: deletedOrphanCount,
    });
  }

  if (orphanedPlaceholders.length > 0) {
    logger.info('Found orphaned placeholders to adopt', {
      label: 'PlaceholderService',
      count: orphanedPlaceholders.length,
    });
  }

  // Filter out items that already have placeholders (in database)
  // This prevents duplicate placeholder creation when multiple collections include the same item
  const itemsNeedingPlaceholders = itemsWithPosters.filter(
    (item) => !existingByTmdbId.has(item.tmdbId)
  );

  const skippedDuplicateCount =
    itemsWithPosters.length - itemsNeedingPlaceholders.length;
  if (skippedDuplicateCount > 0) {
    logger.info(
      'Skipping placeholder creation for items that already have placeholders',
      {
        label: 'PlaceholderService',
        count: skippedDuplicateCount,
      }
    );
  }

  // Step 1: Create ALL placeholder files (without scanning/overlays)
  const createdPlaceholders: {
    sourceItem: ComingSoonSourceData;
    placeholderPath: string;
  }[] = [];
  let skippedRefusedCount = 0;

  for (const missingItem of itemsNeedingPlaceholders) {
    const sourceItem = sourceMap.get(missingItem.tmdbId);
    if (!sourceItem) {
      continue;
    }

    try {
      // Get Sonarr folder name if available (for TV shows)
      const sonarrFolderName =
        sourceItem.mediaType === 'tv' && sourceItem.tvdbId
          ? sonarrFolderNames?.get(sourceItem.tvdbId)
          : undefined;

      const placeholderPath = await createPlaceholderFile(
        sourceItem,
        config.libraryId,
        sonarrFolderName
      );

      if (placeholderPath === null) {
        // Refuse-to-manage: an unmarked file already sits at the computed path.
        // Not created, not tracked - never enters createdPlaceholders, so the
        // unmatched-cleanup path can never delete it.
        skippedRefusedCount++;
        logger.info(
          'Skipped placeholder creation - existing file at path has no Agregarr marker',
          {
            label: 'PlaceholderService',
            title: sourceItem.title,
            tmdbId: sourceItem.tmdbId,
          }
        );
        continue;
      }

      createdPlaceholders.push({ sourceItem, placeholderPath });

      logger.info('Created placeholder file', {
        label: 'PlaceholderService',
        title: sourceItem.title,
        path: placeholderPath,
      });
    } catch (error) {
      logger.error('Failed to create placeholder file', {
        label: 'PlaceholderService',
        title: sourceItem.title,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (skippedRefusedCount > 0) {
    logger.info(
      'Skipped placeholder creation for files without an Agregarr marker',
      {
        label: 'PlaceholderService',
        configName: config.name,
        skipped: skippedRefusedCount,
      }
    );
  }

  // Check if we have any work to do (created or orphaned placeholders)
  if (createdPlaceholders.length === 0 && orphanedPlaceholders.length === 0) {
    // No new placeholders to create, but existing DB records may have valid Plex items
    // Return CollectionItems for items that already have placeholders with rating keys
    const existingCollectionItems: CollectionItem[] = [];
    for (const item of itemsWithPosters) {
      const existingRecord = existingByTmdbId.get(item.tmdbId);
      if (existingRecord?.plexRatingKey) {
        const sourceItem = sourceMap.get(item.tmdbId);
        if (sourceItem) {
          existingCollectionItems.push({
            ratingKey: existingRecord.plexRatingKey,
            title: existingRecord.title,
            type: sourceItem.mediaType,
            tmdbId: item.tmdbId,
          });
        }
      }
    }

    if (existingCollectionItems.length > 0) {
      logger.info(
        'Returning existing placeholder items (no new creation needed)',
        {
          label: 'PlaceholderService',
          count: existingCollectionItems.length,
        }
      );
      return existingCollectionItems;
    }

    logger.warn(
      'No placeholder files were created and no orphaned placeholders found',
      {
        label: 'PlaceholderService',
      }
    );
    return [];
  }

  // Step 2: Trigger directory-scoped Plex scans for newly created files
  // (skip if only orphaned). Never a whole-library scan on this path - with
  // "Empty trash automatically after every scan" enabled on the Plex server,
  // a full scan during a mount blip marks real items missing and purges them.
  let discoveredItemsMap = new Map<
    number,
    { ratingKey: string; title: string }
  >();
  let excludedUnmatchedSet = new Set<number>(); // Track items already deleted by fallback

  if (createdPlaceholders.length > 0) {
    logger.info('Triggering scoped Plex scans for newly created placeholders', {
      label: 'PlaceholderService',
      libraryId: config.libraryId,
      fileCount: createdPlaceholders.length,
    });

    await scanNewPlaceholderDirectories(
      plexClient,
      config.libraryId,
      createdPlaceholders
    );

    // Step 3: Poll for ALL items to be discovered
    const discoveryResult = await waitForPlexDiscovery(
      createdPlaceholders,
      config,
      plexClient
    );
    discoveredItemsMap = discoveryResult.discovered;
    excludedUnmatchedSet = discoveryResult.excludedUnmatched;
  }

  // Add orphaned placeholders to discovered map (they're already in Plex)
  for (const orphaned of orphanedPlaceholders) {
    discoveredItemsMap.set(orphaned.sourceItem.tmdbId, orphaned.plexItem);
  }

  // Build maps for poster verification
  const placeholderPathMap = new Map<number, string>();
  for (const { sourceItem, placeholderPath } of [
    ...createdPlaceholders,
    ...orphanedPlaceholders,
  ]) {
    placeholderPathMap.set(sourceItem.tmdbId, placeholderPath);
  }

  // Verify that discovered placeholders have posters in Plex
  // If Plex has no poster (common for future releases), apply the TMDB poster directly
  discoveredItemsMap = await verifyPlexPosters(
    discoveredItemsMap,
    config,
    plexClient,
    placeholderPathMap,
    sourceMap
  );

  const matchedPlaceholders = createdPlaceholders.filter((placeholder) =>
    discoveredItemsMap.has(placeholder.sourceItem.tmdbId)
  );
  // Filter out items already deleted by the fallback handler during polling
  const unmatchedPlaceholders = createdPlaceholders.filter(
    (placeholder) =>
      !discoveredItemsMap.has(placeholder.sourceItem.tmdbId) &&
      !excludedUnmatchedSet.has(placeholder.sourceItem.tmdbId)
  );

  if (unmatchedPlaceholders.length > 0) {
    await quarantineUndiscoveredPlaceholders(unmatchedPlaceholders, config);
  }

  // Step 4: Apply overlays to ALL placeholders (newly created + orphaned)
  const allPlaceholders = [
    ...matchedPlaceholders.map((p) => ({
      sourceItem: p.sourceItem,
      placeholderPath: p.placeholderPath,
    })),
    ...orphanedPlaceholders,
  ];

  // Step 4: Set metadata markers and save to database for cleanup tracking
  const repository = getRepository(ComingSoonItem);

  for (const { sourceItem, placeholderPath } of allPlaceholders) {
    const plexItem = discoveredItemsMap.get(sourceItem.tmdbId);
    if (!plexItem) continue;

    // Item matched - drop any negative-cache entry from earlier failures
    await clearUnmatchedPlaceholder(
      config.libraryId,
      sourceItem.mediaType,
      sourceItem.tmdbId
    );

    try {
      // Set metadata markers for Recently Added filtering
      // Label is the primary exclusion mechanism (used by filtered hub smart collections)
      // Wrapped separately so a Plex API failure doesn't prevent DB persist
      try {
        await plexClient.addLabelToItem(
          plexItem.ratingKey,
          'trailer-placeholder'
        );
        logger.debug('Added placeholder label', {
          label: 'PlaceholderService',
          title: sourceItem.title,
          mediaType: sourceItem.mediaType,
          ratingKey: plexItem.ratingKey,
        });

        if (sourceItem.mediaType === 'tv') {
          // Also set episode title as secondary marker (used by overlay system)
          const titleSet = await ensurePlaceholderEpisodeTitle(
            plexClient,
            plexItem.ratingKey,
            sourceItem.title
          );
          if (!titleSet) {
            logger.warn(
              'Failed to set placeholder episode title (label still applied)',
              {
                label: 'PlaceholderService',
                title: sourceItem.title,
                ratingKey: plexItem.ratingKey,
              }
            );
          }
        }
      } catch (labelError) {
        // Label will be re-applied on next discovery sync — don't block DB persist
        logger.warn('Failed to apply placeholder label', {
          label: 'PlaceholderService',
          title: sourceItem.title,
          ratingKey: plexItem.ratingKey,
          error:
            labelError instanceof Error
              ? labelError.message
              : String(labelError),
        });
      }

      // Save placeholder to database for lifecycle tracking only
      // NOTE: We don't store cached context (releaseDate, seasonNumber, isPlaceholder)
      // Those are fetched fresh from live sources (TMDB, Plex, Sonarr/Radarr)

      // Check if record already exists for THIS collection
      // Note: The same tmdbId can exist in multiple collections, so we check by both configId and tmdbId
      const existingRecord = await repository.findOne({
        where: {
          configId: config.id,
          tmdbId: sourceItem.tmdbId,
        },
      });

      // Convert absolute path to relative path before storing
      const { getPlaceholderRootFolder } = await import(
        '@server/lib/placeholders/helpers/placeholderPathHelpers'
      );
      const libraryPath = getPlaceholderRootFolder(
        config.libraryId,
        sourceItem.mediaType
      );

      let relativePath = placeholderPath;
      if (libraryPath && placeholderPath.startsWith(libraryPath)) {
        // Remove library root to get relative path
        relativePath = path.relative(libraryPath, placeholderPath);
      } else if (libraryPath && !path.isAbsolute(placeholderPath)) {
        // Already relative
        relativePath = placeholderPath;
      }

      if (existingRecord) {
        // Update existing record with new plexRatingKey and path
        existingRecord.plexRatingKey = plexItem.ratingKey;
        existingRecord.placeholderPath = relativePath;
        await repository.save(existingRecord);

        logger.info('Updated existing database record for placeholder', {
          label: 'PlaceholderService',
          title: sourceItem.title,
          tmdbId: sourceItem.tmdbId,
          configId: config.id,
        });
      } else {
        // Create new record for THIS collection
        // If this is an orphaned placeholder, it gets adopted by this collection
        const placeholderRecord = repository.create({
          configId: config.id, // Always use the current collection's ID
          mediaType: sourceItem.mediaType,
          tmdbId: sourceItem.tmdbId,
          tvdbId: sourceItem.tvdbId,
          title: sourceItem.title,
          year: sourceItem.year,
          source: sourceItem.source,
          placeholderPath: relativePath,
          plexRatingKey: plexItem.ratingKey,
        });

        await repository.save(placeholderRecord);

        logger.info('Created database record for placeholder', {
          label: 'PlaceholderService',
          title: sourceItem.title,
          tmdbId: sourceItem.tmdbId,
          configId: config.id,
          placeholderPath: relativePath,
          isOrphaned: orphanedPlaceholders.some(
            (o) => o.sourceItem.tmdbId === sourceItem.tmdbId
          ),
        });
      }

      // Staleness guard: a record now exists for this path, so clear any stale
      // `orphanedAt` the sweep may have stamped while the item was record-less.
      // Prevents an ancient stamp from short-circuiting the grace window years
      // later if the config is disabled and the file goes record-less again.
      // Persist is once-per-lifecycle, so this costs one marker read per newly
      // persisted item. Resolve the ABSOLUTE marker dir: adopted-orphan
      // placeholderPath is relative, so dirname(placeholderPath) would resolve
      // against cwd and silently no-op (the only class this guard serves).
      if (libraryPath) {
        const { clearMarkerOrphaned, resolveRecordPath } = await import(
          '@server/lib/placeholders/placeholderManager'
        );
        const absPlaceholderPath = resolveRecordPath(libraryPath, relativePath);
        await clearMarkerOrphaned(path.dirname(absPlaceholderPath));
      }
    } catch (error) {
      logger.error('Failed to set metadata markers for placeholder', {
        label: 'PlaceholderService',
        title: sourceItem.title,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Step 6: Convert discovered items to CollectionItem format
  // Create a map of tmdbId -> originalPosition to preserve source order
  const positionMap = new Map<number, number>(
    missingItems
      .filter((item) => item.originalPosition !== undefined)
      .map((item) => [item.tmdbId, item.originalPosition as number])
  );

  const collectionItems: CollectionItem[] = [];
  for (const [tmdbId, plexItem] of discoveredItemsMap) {
    const sourceItem = sourceMap.get(tmdbId);
    if (sourceItem) {
      collectionItems.push({
        ratingKey: plexItem.ratingKey,
        title: plexItem.title,
        type: sourceItem.mediaType,
        tmdbId: tmdbId,
      });
    }
  }

  // Sort by original position to preserve source list order
  // This ensures placeholder items appear in the same order as they were in the source
  // Items without originalPosition will appear at the end
  if (positionMap.size > 0) {
    collectionItems.sort((a, b) => {
      // Get positions, handling undefined tmdbId
      const posA =
        a.tmdbId !== undefined ? positionMap.get(a.tmdbId) : undefined;
      const posB =
        b.tmdbId !== undefined ? positionMap.get(b.tmdbId) : undefined;

      // Items without position go to the end
      if (posA === undefined && posB === undefined) return 0;
      if (posA === undefined) return 1;
      if (posB === undefined) return -1;

      return posA - posB;
    });
  }

  logger.info('Returning discovered placeholder items in source order', {
    label: 'PlaceholderService',
    itemCount: collectionItems.length,
  });

  return collectionItems;
}

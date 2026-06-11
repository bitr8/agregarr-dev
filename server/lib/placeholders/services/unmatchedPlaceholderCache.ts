import { getRepository } from '@server/datasource';
import { UnmatchedPlaceholderCache } from '@server/entity/UnmatchedPlaceholderCache';
import logger from '@server/logger';

const UNMATCHED_TTL_DAYS = 7;

/** Format Date as 'YYYY-MM-DD HH:MM:SS' for SQLite datetime comparisons */
function sqliteDateTime(date: Date): string {
  return date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '');
}

function ttlFromNow(): Date {
  return new Date(Date.now() + UNMATCHED_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Filter out items that recently failed Plex matching in this library.
 * Prevents the create -> unmatched -> delete -> recreate loop that re-downloads
 * trailers for the same titles every sync.
 */
export async function filterRecentlyUnmatched<
  T extends { tmdbId: number; mediaType: 'movie' | 'tv'; title: string }
>(libraryId: string, items: T[]): Promise<T[]> {
  if (items.length === 0) {
    return items;
  }

  try {
    const repository = getRepository(UnmatchedPlaceholderCache);

    // Expired entries are eligible for retry - remove them first
    await repository
      .createQueryBuilder()
      .delete()
      .where('expiresAt < :now', { now: sqliteDateTime(new Date()) })
      .execute();

    const activeEntries = await repository.find({ where: { libraryId } });
    if (activeEntries.length === 0) {
      return items;
    }

    const blocked = new Set(
      activeEntries.map((entry) => `${entry.mediaType}:${entry.tmdbId}`)
    );
    const filtered = items.filter(
      (item) => !blocked.has(`${item.mediaType}:${item.tmdbId}`)
    );

    if (filtered.length < items.length) {
      logger.info(
        'Skipping placeholder creation for items Plex recently failed to match',
        {
          label: 'PlaceholderService',
          libraryId,
          skippedCount: items.length - filtered.length,
          remainingCount: filtered.length,
        }
      );
    }

    return filtered;
  } catch (error) {
    logger.warn('Failed to check unmatched placeholder cache', {
      label: 'PlaceholderService',
      libraryId,
      error: error instanceof Error ? error.message : String(error),
    });
    return items;
  }
}

/**
 * Record a placeholder Plex could not match so the next syncs skip it
 * until the entry expires.
 */
export async function recordUnmatchedPlaceholder(
  libraryId: string,
  item: { tmdbId: number; mediaType: 'movie' | 'tv'; title: string }
): Promise<void> {
  try {
    const repository = getRepository(UnmatchedPlaceholderCache);

    // Atomic upsert - concurrent collection syncs can record the same item
    await repository.query(
      `INSERT INTO unmatched_placeholder_cache ("libraryId", "mediaType", "tmdbId", "title", "attemptCount", "expiresAt")
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT("libraryId", "mediaType", "tmdbId")
       DO UPDATE SET "attemptCount" = "attemptCount" + 1, "expiresAt" = excluded."expiresAt", "updatedAt" = datetime('now')`,
      [
        libraryId,
        item.mediaType,
        item.tmdbId,
        item.title,
        sqliteDateTime(ttlFromNow()),
      ]
    );
  } catch (error) {
    logger.warn('Failed to record unmatched placeholder', {
      label: 'PlaceholderService',
      libraryId,
      title: item.title,
      tmdbId: item.tmdbId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Clear the negative-cache entry once an item matches successfully.
 */
export async function clearUnmatchedPlaceholder(
  libraryId: string,
  mediaType: 'movie' | 'tv',
  tmdbId: number
): Promise<void> {
  try {
    const repository = getRepository(UnmatchedPlaceholderCache);
    await repository.delete({ libraryId, mediaType, tmdbId });
  } catch (error) {
    logger.warn('Failed to clear unmatched placeholder cache entry', {
      label: 'PlaceholderService',
      libraryId,
      tmdbId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

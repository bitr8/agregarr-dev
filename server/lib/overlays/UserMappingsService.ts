import type { IconMapping } from '@server/entity/OverlayTemplate';
import logger from '@server/logger';
import fs from 'fs';
import path from 'path';
import { getDefaultMappings } from './DefaultMappingsService';

// Config directory for user mapping overrides
const CONFIG_DIR = process.env.CONFIG_DIRECTORY || './config';
const USER_MAPPINGS_DIR = path.join(CONFIG_DIR, 'overlay-mappings');
const USER_MAPPINGS_FILE = path.join(USER_MAPPINGS_DIR, 'user-mappings.json');

/**
 * User mapping customizations structure
 * Stores only the user's modifications (additions, updates, deletions)
 */
interface UserMappingsData {
  // Field name -> array of user mappings
  // Each mapping can be an addition, update, or marked for deletion
  [field: string]: IconMapping[];
}

/**
 * Ensure the mappings directory exists
 */
function ensureMappingsDir(): void {
  if (!fs.existsSync(USER_MAPPINGS_DIR)) {
    fs.mkdirSync(USER_MAPPINGS_DIR, { recursive: true });
  }
}

// Cache of the parsed mappings file, guarded by mtime/size so external
// edits are still picked up. Avoids a blocking read+parse on every call —
// getMergedMappings() runs in the overlay render hot path (snapshot-miss
// fallback), which can mean thousands of calls per sync.
let cachedMappings: UserMappingsData | null = null;
let cachedMtimeMs: number | null = null;
let cachedSize: number | null = null;

function invalidateMappingsCache(): void {
  cachedMappings = null;
  cachedMtimeMs = null;
  cachedSize = null;
}

/**
 * Load user mapping customizations from disk
 * Re-reads only when the file's mtime/size changes; otherwise serves the
 * cached parse. Callers must not mutate the returned object directly —
 * write paths persist via saveUserMappings(), which invalidates the cache.
 */
function loadUserMappings(): UserMappingsData {
  try {
    const stats = fs.statSync(USER_MAPPINGS_FILE, { throwIfNoEntry: false });
    if (!stats) {
      invalidateMappingsCache();
      return {};
    }
    if (
      cachedMappings &&
      cachedMtimeMs === stats.mtimeMs &&
      cachedSize === stats.size
    ) {
      return cachedMappings;
    }
    const data = fs.readFileSync(USER_MAPPINGS_FILE, 'utf-8');
    cachedMappings = JSON.parse(data) as UserMappingsData;
    cachedMtimeMs = stats.mtimeMs;
    cachedSize = stats.size;
    return cachedMappings;
  } catch (error) {
    logger.error('Failed to load user mappings', {
      label: 'UserMappingsService',
      error: error instanceof Error ? error.message : String(error),
    });
    invalidateMappingsCache();
    return {};
  }
}

/**
 * Save user mapping customizations to disk
 */
function saveUserMappings(data: UserMappingsData): void {
  try {
    ensureMappingsDir();
    fs.writeFileSync(
      USER_MAPPINGS_FILE,
      JSON.stringify(data, null, 2),
      'utf-8'
    );
  } catch (error) {
    logger.error('Failed to save user mappings', {
      label: 'UserMappingsService',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    // Always drop the cache: on success so the next read reflects the new
    // file even if mtime resolution is coarse; on failure so a mutated
    // in-memory object is never served in place of what's on disk.
    invalidateMappingsCache();
  }
}

/**
 * Get merged mappings for a field (defaults + user overrides)
 * User mappings completely replace defaults when present for a field
 */
export function getMergedMappings(field: string): IconMapping[] {
  const userMappings = loadUserMappings();

  // If user has custom mappings for this field, use them exclusively
  if (userMappings[field] && userMappings[field].length > 0) {
    return userMappings[field];
  }

  // Otherwise, return defaults
  return getDefaultMappings(field);
}

/**
 * Save user mappings for a specific field
 * Replaces all mappings for that field with the provided ones
 */
export function saveFieldMappings(
  field: string,
  mappings: IconMapping[]
): void {
  const userMappings = loadUserMappings();

  if (mappings.length === 0) {
    // If empty, remove user overrides (revert to defaults)
    delete userMappings[field];
  } else {
    userMappings[field] = mappings;
  }

  saveUserMappings(userMappings);

  logger.info('Saved user mappings for field', {
    label: 'UserMappingsService',
    field,
    mappingCount: mappings.length,
  });
}

/**
 * Reset mappings for a field back to defaults
 */
export function resetFieldMappings(field: string): void {
  const userMappings = loadUserMappings();
  delete userMappings[field];
  saveUserMappings(userMappings);

  logger.info('Reset mappings to defaults for field', {
    label: 'UserMappingsService',
    field,
  });
}

/**
 * Check if user has custom mappings for a field
 */
export function hasUserMappings(field: string): boolean {
  const userMappings = loadUserMappings();
  return (userMappings[field]?.length || 0) > 0;
}

/**
 * Get all fields with user customizations
 */
export function getFieldsWithUserMappings(): string[] {
  const userMappings = loadUserMappings();
  return Object.keys(userMappings).filter(
    (key) => userMappings[key].length > 0
  );
}

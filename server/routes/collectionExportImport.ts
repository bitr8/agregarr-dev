import { TimeRestrictionUtils } from '@server/lib/collections/utils/TimeRestrictionUtils';
import type { CollectionConfig } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';

// --- Deprecated field migration (live: comingSoonDays/comingSoonReleasedDays still written by the form) ---

export function migrateDeprecatedFields(
  config: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...config };

  if (
    result.comingSoonReleasedDays !== undefined &&
    result.placeholderReleasedDays === undefined
  )
    result.placeholderReleasedDays = result.comingSoonReleasedDays;
  if (
    result.comingSoonDays !== undefined &&
    result.placeholderDaysAhead === undefined
  )
    result.placeholderDaysAhead = result.comingSoonDays;

  return result;
}

// --- Field classification (whitelist / stripped) ---

const portableFields = [
  'name',
  'type',
  'subtype',
  'template',
  'customMovieTemplate',
  'customTVTemplate',
  'dynamicTitlePrefix',
  'visibilityConfig',
  'sortOrderHome',
  'sortOrderLibrary',
  'isLibraryPromoted',
  'randomizeHomeOrder',
  'tmdbCustomCollectionUrl',
  'traktCustomListUrl',
  'imdbCustomListUrl',
  'letterboxdCustomListUrl',
  'mdblistCustomListUrl',
  'anilistCustomListUrl',
  'watchProviderId',
  'region',
  'networksCountry',
  'tmdbMovieSortBy',
  'tmdbTvSortBy',
  'tmdbAdvancedFilters',
  'timePeriod',
  'traktStatType',
  'tautulliStatType',
  'filterSettings',
  'maxItems',
  'customDays',
  'minimumPlays',
  'maxPositionToProcess',
  'minimumYear',
  'minimumImdbRating',
  'minimumRottenTomatoesRating',
  'minimumRottenTomatoesAudienceRating',
  'sortOrder',
  'showUnwatchedOnly',
  'filterUnwatched',
  'smartCollectionSort',
  'plexLabel',
  'personMinimumItems',
  'useSeparator',
  'separatorTitle',
  'hideIndividualItems',
  'applyOverlaysDuringSync',
  'autoPoster',
  'useTmdbFranchisePoster',
  'customSummary',
  'enableCustomWallpaper',
  'enableCustomSummary',
  'enableCustomTheme',
  'createPlaceholdersForMissing',
  'placeholderReleasedDays',
  'placeholderDaysAhead',
  'includeAllReleasedItems',
  'placeholderMinimumYear',
  'placeholderMinimumImdbRating',
  'placeholderMinimumRottenTomatoesRating',
  'placeholderMinimumRottenTomatoesAudienceRating',
  'placeholderFilterSettings',
  'comingSoonFilterByTags',
  'comingSoonTagMode',
  'downloadMode',
  'searchMissingMovies',
  'searchMissingTV',
  'autoApproveMovies',
  'autoApproveTV',
  'maxSeasonsToRequest',
  'seasonsPerShowLimit',
  'seasonGrabOrder',
  'directDownloadRadarrMonitor',
  'directDownloadRadarrSearchOnAdd',
  'directDownloadSonarrMonitor',
  'directDownloadSonarrMonitorType',
  'directDownloadSonarrSearchOnAdd',
  'timeRestriction',
  'customSyncSchedule',
  'isMultiSource',
  'combineMode',
  'sources',
  'selectionMode',
  'excludeValues',
  'includeValues',
  'sortTitleOverride',
] as const satisfies readonly (keyof CollectionConfig)[];

const strippedFields = [
  'id',
  'libraryId',
  'libraryName',
  'collectionRatingKey',
  'collectionRatingKeys',
  'smartCollectionRatingKey',
  'targetUserId',
  'targetUserLabel',
  'radarrInstanceId',
  'sonarrInstanceId',
  'radarrTagId',
  'sonarrTagId',
  'directDownloadRadarrServerId',
  'directDownloadRadarrProfileId',
  'directDownloadRadarrRootFolder',
  'directDownloadRadarrTags',
  'directDownloadSonarrServerId',
  'directDownloadSonarrProfileId',
  'directDownloadSonarrRootFolder',
  'directDownloadSonarrTags',
  'overseerrRadarrServerId',
  'overseerrRadarrProfileId',
  'overseerrRadarrRootFolder',
  'overseerrRadarrTags',
  'overseerrSonarrServerId',
  'overseerrSonarrProfileId',
  'overseerrSonarrRootFolder',
  'overseerrSonarrTags',
  'comingSoonRadarrServerId',
  'comingSoonSonarrServerId',
  'comingSoonRadarrTagIds',
  'comingSoonSonarrTagIds',
  'comingSoonRadarrRootFolder',
  'comingSoonSonarrRootFolder',
  'customPoster',
  'customWallpaper',
  'customTheme',
  'autoPosterTemplate',
  'linkId',
  'isLinked',
  'isUnlinked',
  'excludeFromCollections',
  'excludedGenres',
  'excludedCountries',
  'excludedLanguages',
  'comingSoonReleasedDays',
  'comingSoonDays',
  'lastSyncedAt',
  'lastModifiedAt',
  'needsSync',
  'lastSyncError',
  'lastSyncErrorAt',
  'lastSyncWarning',
  'lastSyncWarningAt',
  'missing',
  'isActive',
  'everLibraryPromoted',
  'isPromotedToHub',
] as const satisfies readonly (keyof CollectionConfig)[];

type PortableField = (typeof portableFields)[number];
type StrippedField = (typeof strippedFields)[number];

// Compile-time exhaustiveness: every CollectionConfig key must be classified
type _Exhaustive = Exclude<
  keyof CollectionConfig,
  PortableField | StrippedField
> extends never
  ? true
  : Exclude<keyof CollectionConfig, PortableField | StrippedField>;
void (true as _Exhaustive);

// Source-level portable fields (whitelist, not blacklist)
const portableSourceFields = new Set([
  'id',
  'type',
  'subtype',
  'customUrl',
  'timePeriod',
  'priority',
  'customDays',
  'minimumPlays',
  'networksCountry',
  'resolvedTitle',
]);

// --- Export helpers ---

function stripScheduleRuntimeFields(
  schedule: Record<string, unknown>
): Record<string, unknown> {
  const cleaned = { ...schedule };
  delete cleaned.firstSyncAt;
  delete cleaned.startNow;
  return cleaned;
}

function cleanSources(
  sources: NonNullable<CollectionConfig['sources']>
): object[] {
  let nextSourceId = 1;
  return sources.map((src) => {
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (portableSourceFields.has(k)) {
        cleaned[k] = v;
      }
    }
    cleaned.id = String(nextSourceId++);
    return cleaned;
  });
}

export function buildExportPayload(
  config: CollectionConfig
): Record<string, unknown> {
  const migrated = migrateDeprecatedFields(
    config as unknown as Record<string, unknown>
  );
  const result: Record<string, unknown> = {};

  for (const field of portableFields) {
    const value = migrated[field];
    if (value === undefined) continue;

    if (field === 'sources' && Array.isArray(value)) {
      result.sources = cleanSources(
        value as unknown as NonNullable<CollectionConfig['sources']>
      );
      continue;
    }

    if (field === 'customSyncSchedule' && typeof value === 'object' && value) {
      result.customSyncSchedule = stripScheduleRuntimeFields(
        value as Record<string, unknown>
      );
      continue;
    }

    result[field] = value;
  }

  result.sortOrderHome = 0;
  result.sortOrderLibrary = 0;

  return result;
}

// --- Import helpers ---

export function buildConfigFromImport(
  payload: Record<string, unknown>,
  id: string,
  libraryId: string,
  libraryName: string,
  name?: string
): CollectionConfig {
  const config: Record<string, unknown> = {};

  for (const field of portableFields) {
    if (field in payload) {
      config[field] = payload[field];
    }
  }

  if (config.sources && Array.isArray(config.sources)) {
    config.sources = cleanSources(
      config.sources as NonNullable<CollectionConfig['sources']>
    );
  }

  if (
    config.customSyncSchedule &&
    typeof config.customSyncSchedule === 'object'
  ) {
    config.customSyncSchedule = stripScheduleRuntimeFields(
      config.customSyncSchedule as Record<string, unknown>
    );
  }

  config.id = id;
  config.libraryId = libraryId;
  config.libraryName = libraryName;
  if (name) config.name = name;
  config.sortOrderHome = 0;
  config.sortOrderLibrary = 0;
  config.needsSync = true;
  config.lastModifiedAt = new Date().toISOString();
  config.isActive = TimeRestrictionUtils.evaluateTimeRestriction(
    config.timeRestriction as CollectionConfig['timeRestriction']
  ).isActive;

  return config as unknown as CollectionConfig;
}

function deduplicateName(name: string, existingNames: Set<string>): string {
  if (!existingNames.has(name)) return name;
  let i = 1;
  while (existingNames.has(`${name} (${i})`)) i++;
  return `${name} (${i})`;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

// --- Routes ---

const collectionExportImportRoutes = Router();

collectionExportImportRoutes.post(
  '/export',
  isAuthenticated(),
  async (req, res) => {
    try {
      const { ids } = req.body;

      if (!Array.isArray(ids) || ids.length === 0) {
        return res
          .status(400)
          .json({ error: 'ids array is required and must not be empty' });
      }

      const settings = getSettings();
      const configs = settings.plex.collectionConfigs || [];
      const idSet = new Set(ids.map(String));
      const matched = configs.filter((c) => idSet.has(c.id));

      if (matched.length === 0) {
        return res
          .status(404)
          .json({ error: 'No matching collection configs found' });
      }

      const collections = matched.map(buildExportPayload);

      const filename =
        matched.length === 1
          ? `agregarr-collection-${slugify(matched[0].name)}.json`
          : 'agregarr-collections-export.json';

      res.set({
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`,
      });

      res.json({
        version: '1.0',
        exportedAt: new Date().toISOString(),
        collections,
      });
    } catch (error) {
      logger.error('Failed to export collections:', error);
      res.status(500).json({ error: 'Failed to export collections' });
    }
  }
);

collectionExportImportRoutes.post(
  '/import',
  isAuthenticated(),
  async (req, res) => {
    try {
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      if (contentLength > 2 * 1024 * 1024) {
        return res.status(413).json({ error: 'Payload too large (max 2 MB)' });
      }

      const { version, collections, libraryId, nameOverrides } = req.body;

      if (version && version !== '1.0') {
        return res.status(400).json({
          error: `Unsupported version: ${version}. This version supports version 1.0.`,
        });
      }

      if (!Array.isArray(collections) || collections.length === 0) {
        return res.status(400).json({
          error: 'collections array is required and must not be empty',
        });
      }

      if (!libraryId) {
        return res.status(400).json({ error: 'libraryId is required' });
      }

      const settings = getSettings();
      const libraries = settings.plex.libraries || [];
      const library = libraries.find((lib) => lib.key === String(libraryId));

      if (!library) {
        return res
          .status(400)
          .json({ error: `Library not found: ${libraryId}` });
      }

      for (const c of collections) {
        if (!c.name || !c.type) {
          return res.status(400).json({
            error: 'Each collection must have name and type fields',
          });
        }
      }

      const existingConfigs = settings.plex.collectionConfigs || [];
      const existingNames = new Set(
        existingConfigs
          .filter((c) => c.libraryId === String(libraryId))
          .map((c) => c.name)
      );

      const { IdGenerator } = await import('@server/utils/idGenerator');
      const ids = IdGenerator.generateIds(collections.length);

      const overrides: Record<string, string> =
        nameOverrides && typeof nameOverrides === 'object' ? nameOverrides : {};

      const created: CollectionConfig[] = [];

      for (let i = 0; i < collections.length; i++) {
        const entry = collections[i];
        const rawName = overrides[entry.name] || entry.name;
        const name = deduplicateName(rawName, existingNames);
        existingNames.add(name);

        const config = buildConfigFromImport(
          entry,
          ids[i],
          String(libraryId),
          library.name,
          name
        );

        created.push(config);
      }

      const configs = settings.plex.collectionConfigs || [];
      configs.push(...created);
      settings.plex.collectionConfigs = configs;
      settings.save();

      logger.info('Imported collection configs', {
        label: 'Collections API',
        count: created.length,
        libraryId,
        names: created.map((c) => c.name),
      });

      res.json({
        message: `Successfully imported ${created.length} collection(s)`,
        count: created.length,
        configs: created.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          libraryId: c.libraryId,
        })),
      });
    } catch (error) {
      logger.error('Failed to import collections:', error);
      res.status(500).json({ error: 'Failed to import collections' });
    }
  }
);

export default collectionExportImportRoutes;

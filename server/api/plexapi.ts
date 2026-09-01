import { fetchPlexMetadataBatches } from '@server/api/plexMetadataBatch';
import type { PlexMetadataSafeResult } from '@server/api/plexMetadataClassify';
import {
  classifyPlexMetadataResponse,
  isPlexNotFoundError,
} from '@server/api/plexMetadataClassify';
import type { PlexHubManagementResponse } from '@server/interfaces/api/plexInterfaces';
import PlexHubManager from '@server/lib/collections/plex/PlexHubManager';
import PlexPosterManager from '@server/lib/collections/plex/PlexPosterManager';
import PlexSmartCollectionManager from '@server/lib/collections/plex/PlexSmartCollectionManager';
import type { Library, PlexSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { registerLogSecrets } from '@server/utils/logRedaction';
import NodePlexAPI from 'plex-api';

// Re-export so existing consumers can keep importing the result type from the
// Plex client module; the classifiers themselves live in a dep-free sibling so
// they stay unit-testable without the full client graph.
export type { PlexMetadataSafeResult };

// Extended interface for type-safe Plex API HTTP methods
interface ExtendedPlexAPI extends NodePlexAPI {
  postQuery?: (url: string) => Promise<unknown>;
  putQuery?: (url: string) => Promise<void>;
  deleteQuery?: (url: string) => Promise<void>;
}

export interface PlexLibraryItem {
  ratingKey: string;
  parentRatingKey?: string;
  grandparentRatingKey?: string;
  title: string;
  parentTitle?: string;
  grandparentTitle?: string;
  guid: string;
  parentGuid?: string;
  grandparentGuid?: string;
  addedAt: number;
  updatedAt: number;
  lastViewedAt?: number;
  viewCount?: number;
  year?: number;
  originallyAvailableAt?: string; // Original release date (YYYY-MM-DD format)
  index?: number;
  parentIndex?: number;
  editionTitle?: string;
  userRating?: number; // User rating from server admin/user (0-10 scale where 10 = 5 stars)
  Guid?: {
    id: string;
  }[];
  Label?: { tag: string; id?: number }[]; // Item-level labels/tags in Plex
  type: 'movie' | 'show' | 'season' | 'episode';
  childCount?: number; // Number of seasons for show-type items
  Media: Media[];
}

interface PlexLibraryResponse {
  MediaContainer: {
    totalSize: number;
    Metadata: PlexLibraryItem[];
  };
}

export interface PlexLibrary {
  type: 'show' | 'movie';
  key: string;
  title: string;
  agent: string;
}

interface PlexLibrariesResponse {
  MediaContainer: {
    Directory: PlexLibrary[];
  };
}

export interface PlexMetadata {
  ratingKey: string;
  parentRatingKey?: string;
  grandparentRatingKey?: string;
  guid: string;
  type: 'movie' | 'show' | 'season' | 'episode';
  title: string;
  thumb?: string;
  parentThumb?: string;
  parentTitle?: string;
  grandparentTitle?: string;
  librarySectionID?: number;
  editionTitle?: string;
  Guid: {
    id: string;
  }[];
  Label?: { tag: string; id?: number }[]; // Item-level labels/tags in Plex
  Children?: {
    size: number;
    Directory?: PlexMetadata[];
    Metadata?: PlexMetadata[];
  };
  index: number;
  parentIndex?: number;
  leafCount: number;
  viewedLeafCount: number;
  userRating?: number;
  addedAt: number;
  updatedAt: number;
  lastViewedAt?: number;
  viewCount?: number;
  Media: Media[];
}

export interface PlexStream {
  id: number;
  streamType: number; // 1=video, 2=audio, 3=subtitle
  codec: string;

  // Video stream fields
  DOVIPresent?: boolean;
  DOVIProfile?: number; // Dolby Vision profile (5, 7, 8, etc.)
  DOVILevel?: number;
  DOVIVersion?: string;
  DOVIBLPresent?: boolean;
  DOVIELPresent?: boolean;
  DOVIRPUPresent?: boolean;
  DOVIBLCompatID?: number;
  height?: number;
  width?: number;
  colorPrimaries?: string;
  colorSpace?: string;
  colorTrc?: string;
  bitDepth?: number;
  chromaSubsampling?: string;

  // Audio stream fields
  channels?: number;
  audioChannelLayout?: string;
  displayTitle?: string;
  extendedDisplayTitle?: string;
  profile?: string;
  language?: string;
  languageCode?: string;

  // Subtitle stream fields
  format?: string;
  forced?: boolean;
}

export interface PlexPart {
  id: number;
  file: string;
  size: number;
  Stream?: PlexStream[];
}

export interface Media {
  id: number;
  duration: number;
  bitrate: number;
  width: number;
  height: number;
  aspectRatio: number;
  audioChannels: number;
  audioCodec: string;
  videoCodec: string;
  videoResolution: string;
  container: string;
  videoFrameRate: string;
  videoProfile: string;
  Part?: PlexPart[];
}

interface PlexMetadataResponse {
  MediaContainer: {
    Metadata: PlexMetadata[];
  };
}

export interface PlexCollectionItem {
  ratingKey: string;
  title: string;
  addedAt?: number;
  [key: string]: unknown;
}

interface PlexCollection {
  ratingKey: string;
  title: string;
  type: string;
  addedAt?: number;
  labels: string[];
  libraryKey?: string;
  libraryName?: string;
  titleSort?: string;
  collectionSort?: string;
  Label?: { tag: string; id?: number }[];
  [key: string]: unknown;
}

interface PlexCollectionMetadata extends PlexCollection {
  summary?: string;
  childCount?: number;
  thumb?: string;
  art?: string;
  titleSort?: string;
  collectionSort?: string;
  smart?: string; // Smart collections have smart="1" attribute (Plex returns string)
}

interface PlexCollectionResponse {
  MediaContainer: {
    Metadata: PlexCollection[];
    size?: number;
    totalSize?: number;
  };
}

class PlexAPI {
  private plexClient: NodePlexAPI;
  private plexToken?: string;
  private hubManager: PlexHubManager;
  private smartCollectionManager: PlexSmartCollectionManager;
  private posterManager: PlexPosterManager;
  private autoEmptyTrashPrefPromise?: Promise<boolean>;

  // Write telemetry - scoped to this instance (one PlexAPI per sync run), not
  // a global singleton, so overlapping syncs never share counts.
  private writeCounts = new Map<string, number>();
  private phaseTimingsMs = new Map<string, number>();
  private collectionProcessingMs = 0;

  private static readonly WRITE_CATEGORIES = [
    'title',
    'sortTitle',
    'contentSort',
    'hubVisibility',
    'label',
    'poster',
    'arrange',
    'mode',
  ] as const;

  private static readonly PHASE_ORDER = [
    'sourceFetch',
    'contentUpdate',
    'metadataUpdate',
    'hubSync',
    'ordering',
  ] as const;

  public recordWrite(category: string): void {
    this.writeCounts.set(category, (this.writeCounts.get(category) ?? 0) + 1);
  }

  public shouldSkipUnchangedWrites(): boolean {
    return getSettings().main.skipUnchangedPlexWrites !== false;
  }

  public recordPhaseTime(phase: string, ms: number): void {
    this.phaseTimingsMs.set(phase, (this.phaseTimingsMs.get(phase) ?? 0) + ms);
  }

  // Total time spent inside processConfiguration() across every collection
  // this sync. Not logged directly - it's the base that sourceFetch is
  // derived from in getPhaseSummary().
  public recordCollectionProcessingTime(ms: number): void {
    this.collectionProcessingMs += ms;
  }

  public getWriteSummary(): { total: number; text: string } {
    const seen = new Set<string>();
    const parts: string[] = [];
    let total = 0;
    for (const category of PlexAPI.WRITE_CATEGORIES) {
      const count = this.writeCounts.get(category) ?? 0;
      parts.push(`${category}: ${count}`);
      total += count;
      seen.add(category);
    }
    for (const [category, count] of this.writeCounts) {
      if (!seen.has(category)) {
        parts.push(`${category}: ${count}`);
        total += count;
      }
    }
    return { total, text: parts.join(', ') };
  }

  // ponytail: sourceFetch is a residual (collectionProcessing minus the two
  // sub-phases timed directly), not an isolated measurement - fetchSourceData
  // is abstract and implemented per source (16 subclasses), so there's no
  // single call site to wrap directly. Upgrade path: thread a timer through
  // fetchSourceData if per-source fetch time is ever needed.
  public getPhaseSummary(): string {
    const contentMs = this.phaseTimingsMs.get('contentUpdate') ?? 0;
    const metadataMs = this.phaseTimingsMs.get('metadataUpdate') ?? 0;
    const sourceFetchMs = Math.max(
      0,
      this.collectionProcessingMs - contentMs - metadataMs
    );
    this.phaseTimingsMs.set('sourceFetch', sourceFetchMs);

    return PlexAPI.PHASE_ORDER.map(
      (phase) =>
        `${phase}: ${Math.round(this.phaseTimingsMs.get(phase) ?? 0)}ms`
    ).join(', ');
  }

  private getExtendedClient(): ExtendedPlexAPI {
    return this.plexClient as ExtendedPlexAPI;
  }

  private async safePostQuery(url: string): Promise<unknown> {
    const client = this.getExtendedClient();
    if (typeof client.postQuery !== 'function') {
      throw new Error(
        'POST operations are not supported by this Plex API version'
      );
    }
    return client.postQuery(url);
  }

  private async safePutQuery(url: string): Promise<void> {
    const client = this.getExtendedClient();
    if (typeof client.putQuery !== 'function') {
      throw new Error(
        'PUT operations are not supported by this Plex API version'
      );
    }
    return client.putQuery(url);
  }

  private async safeDeleteQuery(url: string): Promise<void> {
    const client = this.getExtendedClient();
    if (typeof client.deleteQuery !== 'function') {
      throw new Error(
        'DELETE operations are not supported by this Plex API version'
      );
    }
    return client.deleteQuery(url);
  }

  constructor({
    plexToken,
    plexSettings,
    timeout,
  }: {
    plexToken?: string;
    plexSettings?: PlexSettings;
    timeout?: number;
  }) {
    const settings = getSettings();
    let settingsPlex: PlexSettings | undefined;
    plexSettings
      ? (settingsPlex = plexSettings)
      : (settingsPlex = getSettings().plex);

    // Store the token for later use
    this.plexToken = plexToken;
    // Tokens come from the DB (User.plexToken) and Plex shared-server
    // responses, not settings.json - register here so logs redact them.
    registerLogSecrets([plexToken]);

    this.plexClient = new NodePlexAPI({
      hostname: settingsPlex.ip,
      port: settingsPlex.port,
      https: settingsPlex.useSsl,
      timeout: timeout,
      token: plexToken,
      authenticator: {
        authenticate: (
          _plexApi,
          cb: (err?: string, token?: string) => void
        ) => {
          if (!plexToken) {
            return cb('Plex Token not found!');
          }
          cb(undefined, plexToken);
        },
      },
      options: {
        identifier: settings.clientId,
        product: 'Agregarr',
        deviceName: 'Agregarr',
        platform: 'Agregarr',
      },
    });

    // Initialize hub manager
    this.hubManager = new PlexHubManager(this);

    // Initialize smart collection manager
    this.smartCollectionManager = new PlexSmartCollectionManager(this);

    // Initialize poster manager
    this.posterManager = new PlexPosterManager(this);
  }

  public async getStatus() {
    return await this.plexClient.query('/');
  }

  /**
   * Check if a collection is a smart collection
   * @param collectionRatingKey The rating key of the collection to check
   * @returns 'smart' | 'not_smart', or 'unknown' when the check itself failed -
   *   callers must not treat 'unknown' the same as 'not_smart'
   */
  private async isSmartCollection(
    collectionRatingKey: string
  ): Promise<'smart' | 'not_smart' | 'unknown'> {
    try {
      const metadata = await this.getCollectionMetadata(collectionRatingKey);
      if (!metadata) {
        return 'unknown';
      }

      // Smart collections have smart="1" attribute in Plex API
      return metadata.smart === '1' ? 'smart' : 'not_smart';
    } catch (error) {
      logger.warn(
        `Failed to check if collection ${collectionRatingKey} is smart`,
        {
          label: 'Plex API',
          error: error instanceof Error ? error.message : String(error),
        }
      );
      return 'unknown';
    }
  }

  public async getLibraries(): Promise<PlexLibrary[]> {
    const startTime = Date.now();

    try {
      const response = await this.plexClient.query<PlexLibrariesResponse>(
        '/library/sections'
      );

      // Only log if response time is unusually high (> 500ms) or if it fails
      const responseTime = Date.now() - startTime;
      if (responseTime > 500) {
        logger.warn('Slow Plex libraries fetch detected', {
          label: 'Plex API',
          libraryCount: response.MediaContainer.Directory?.length || 0,
          responseTime,
        });
      }

      return response.MediaContainer.Directory;
    } catch (error) {
      logger.error('Failed to fetch Plex libraries', {
        label: 'Plex API',
        error: error instanceof Error ? error.message : String(error),
        responseTime: Date.now() - startTime,
      });
      throw error;
    }
  }

  public async syncLibraries(): Promise<void> {
    const settings = getSettings();

    try {
      const libraries = await this.getLibraries();

      const newLibraries: Library[] = libraries
        .filter(
          (library) => library.type === 'movie' || library.type === 'show'
        )
        .filter((library) => library.agent !== 'com.plexapp.agents.none')
        .map((library) => {
          const existing = settings.plex.libraries.find(
            (l) => l.key === library.key && l.name === library.title
          );

          return {
            key: library.key,
            name: library.title,
            type: library.type,
            lastScan: existing?.lastScan,
          };
        });

      settings.plex.libraries = newLibraries;
      settings.save();
    } catch (e) {
      logger.error('Failed to sync Plex libraries - keeping existing data', {
        label: 'Plex API',
        message: e.message,
      });
      throw e;
    }
  }

  public async getLibraryContents(
    id: string,
    { offset = 0, size = 50 }: { offset?: number; size?: number } = {}
  ): Promise<{ totalSize: number; items: PlexLibraryItem[] }> {
    const uri = `/library/sections/${id}/all?includeGuids=1`;
    const headers = {
      'X-Plex-Container-Start': `${offset}`,
      'X-Plex-Container-Size': `${size}`,
    };

    const response = await this.plexClient.query<PlexLibraryResponse>({
      uri,
      extraHeaders: headers,
    });

    const totalSize = response.MediaContainer.totalSize;

    return {
      totalSize,
      items: response.MediaContainer.Metadata ?? [],
    };
  }

  /**
   * Fetch all items of a specific type from a library section.
   * type=4 for episodes, type=3 for seasons, type=2 for shows, type=1 for movies.
   * Paginates automatically with configurable page size.
   */
  public async getLibraryItemsByType(
    libraryId: string,
    type: number,
    { pageSize = 1000 }: { pageSize?: number } = {}
  ): Promise<PlexLibraryItem[]> {
    const allItems: PlexLibraryItem[] = [];
    let offset = 0;
    let totalSize = 0;
    let callCount = 0;
    const startTime = Date.now();

    do {
      const response = await this.plexClient.query<PlexLibraryResponse>({
        uri: `/library/sections/${libraryId}/all?type=${type}&includeGuids=1`,
        extraHeaders: {
          'X-Plex-Container-Start': `${offset}`,
          'X-Plex-Container-Size': `${pageSize}`,
        },
      });

      totalSize = response.MediaContainer.totalSize;
      const items = response.MediaContainer.Metadata ?? [];
      allItems.push(...items);
      callCount++;
      if (items.length === 0) {
        logger.warn('Empty page returned from Plex, stopping pagination', {
          label: 'Plex API',
          libraryId,
          type,
          offset,
          totalSize,
        });
        break;
      }
      offset += items.length;
    } while (offset < totalSize);

    logger.debug('Fetched library items by type', {
      label: 'Plex API',
      libraryId,
      type,
      totalItems: allItems.length,
      apiCalls: callCount,
      durationMs: Date.now() - startTime,
    });

    return allItems;
  }

  public async getMetadata(
    key: string,
    options: { includeChildren?: boolean } = {}
  ): Promise<PlexMetadata> {
    const response = await this.plexClient.query<PlexMetadataResponse>(
      `/library/metadata/${key}${
        options.includeChildren ? '?includeChildren=1' : ''
      }`
    );

    return response.MediaContainer.Metadata[0];
  }

  /**
   * Guarded single-item metadata fetch that never throws. Classifies the
   * outcome so callers can safely distinguish a confirmed deletion from an
   * ambiguous transport failure:
   *   - 'ok'        item exists, metadata returned
   *   - 'not_found' Plex confirmed the key is gone (HTTP 404, or a well-formed
   *                 Plex MediaContainer with no item) — safe to treat as deleted
   *   - 'error'     ambiguous (network/auth/5xx/non-Plex 2xx) — callers MUST
   *                 NOT delete on it
   *
   * plex-api (v5.3.2) exposes NO structured status code (verified: statusCode /
   * code / status are all undefined); the HTTP status is only in the Error
   * message as "response code: <n>". We parse that exact number rather than
   * substring-matching "404", so a ratingKey or URL that happens to contain the
   * digits 404 can never be misread as a deletion. Any other failure, and any
   * successful-but-non-Plex body (a reverse proxy / auth / captive-portal page
   * arrives as a string/Buffer or an object with no MediaContainer), is
   * ambiguous -> 'error'. The 'not_found' branch gates a destructive cleanup, so
   * it must only fire on a genuine, unambiguous absence.
   */
  public async getMetadataSafe(key: string): Promise<PlexMetadataSafeResult> {
    let response: unknown;
    try {
      response = await this.plexClient.query<PlexMetadataResponse>(
        `/library/metadata/${key}`
      );
    } catch (error) {
      const errorMessage = (error as Error).message ?? '';
      if (isPlexNotFoundError(errorMessage)) {
        return { status: 'not_found' };
      }
      logger.warn('Ambiguous Plex metadata fetch failure', {
        label: 'Plex API',
        key,
        error: errorMessage,
      });
      return { status: 'error' };
    }

    const result = classifyPlexMetadataResponse(response);
    if (result.status === 'error') {
      logger.warn('Unexpected non-Plex response for metadata fetch', {
        label: 'Plex API',
        key,
      });
    }
    return result;
  }

  /**
   * Fetch metadata for multiple items in a single Plex API call.
   * Returns a Map keyed by ratingKey for O(1) lookups.
   * Chunks requests to avoid Plex URL length limits (~8KB).
   */
  public async getMetadataBatch(
    ratingKeys: string[]
  ): Promise<Map<string, PlexMetadata>> {
    return fetchPlexMetadataBatches(
      ratingKeys,
      async (chunk) => {
        const response = await this.plexClient.query<PlexMetadataResponse>(
          `/library/metadata/${chunk.join(',')}`
        );
        return response.MediaContainer.Metadata ?? [];
      },
      {
        onRetry: (chunk, error, attempt) =>
          logger.warn('Plex metadata batch failed transiently; retrying', {
            label: 'Plex API',
            chunkSize: chunk.length,
            totalRequested: ratingKeys.length,
            attempt,
            error,
          }),
        onFailure: (chunk, error) =>
          logger.error(
            'Plex metadata batch failed after retry and split; unresolved items will use individual fetches',
            {
              label: 'Plex API',
              unresolvedItems: chunk.length,
              totalRequested: ratingKeys.length,
              error,
            }
          ),
      }
    );
  }

  public async getChildrenMetadata(key: string): Promise<PlexMetadata[]> {
    const response = await this.plexClient.query<{
      MediaContainer: {
        Metadata?: PlexMetadata[];
        Directory?: PlexMetadata[];
      };
    }>(`/library/metadata/${key}/children`);
    return (
      response.MediaContainer.Metadata ||
      response.MediaContainer.Directory ||
      []
    );
  }

  /**
   * Find a specific episode within a show
   * @param showRatingKey - The show's Plex rating key
   * @param seasonNumber - Season number (1-based)
   * @param episodeNumber - Episode number within the season (1-based)
   * @returns The episode's PlexLibraryItem or null if not found
   */
  public async getShowEpisode(
    showRatingKey: string,
    seasonNumber: number,
    episodeNumber: number
  ): Promise<PlexLibraryItem | null> {
    try {
      // First get all seasons for the show
      const seasons = await this.getChildrenMetadata(showRatingKey);

      // Find the specific season
      const season = seasons.find(
        (s) => s.type === 'season' && s.index === seasonNumber
      );

      if (!season) {
        logger.debug(
          `Season ${seasonNumber} not found for show ${showRatingKey}`,
          {
            label: 'PlexAPI',
          }
        );
        return null;
      }

      // Get all episodes for this season
      const episodes = await this.getChildrenMetadata(season.ratingKey);

      // Find the specific episode
      const episode = episodes.find(
        (e) => e.type === 'episode' && e.index === episodeNumber
      );

      if (!episode) {
        logger.debug(
          `Episode ${episodeNumber} not found in season ${seasonNumber} for show ${showRatingKey}`,
          { label: 'PlexAPI' }
        );
        return null;
      }

      return episode as PlexLibraryItem;
    } catch (error) {
      logger.error(
        `Failed to find episode S${seasonNumber}E${episodeNumber} for show ${showRatingKey}`,
        {
          label: 'PlexAPI',
          error: error instanceof Error ? error.message : String(error),
        }
      );
      return null;
    }
  }

  /**
   * Get all episodes from a show
   * @param showRatingKey - The show's Plex rating key
   * @returns Array of all episodes in the show with their metadata including TMDB GUIDs
   */
  public async getAllEpisodesFromShow(
    showRatingKey: string
  ): Promise<PlexLibraryItem[]> {
    try {
      // Get all seasons for the show
      const seasons = await this.getChildrenMetadata(showRatingKey);
      const allEpisodes: PlexLibraryItem[] = [];

      // Get episodes from each season
      for (const season of seasons) {
        if (season.type === 'season') {
          const episodes = await this.getChildrenMetadata(season.ratingKey);

          // For each episode, get full metadata including GUIDs
          for (const episode of episodes.filter(
            (ep) => ep.type === 'episode'
          )) {
            try {
              // Get full episode metadata with GUIDs
              const fullEpisodeMetadata = await this.getMetadata(
                episode.ratingKey
              );
              allEpisodes.push(fullEpisodeMetadata as PlexLibraryItem);
            } catch (error) {
              logger.warn(
                `Failed to get full metadata for episode ${episode.ratingKey}`,
                {
                  label: 'Plex API',
                  error: error instanceof Error ? error.message : String(error),
                }
              );
              // Fallback to basic episode metadata (without GUIDs)
              allEpisodes.push(episode as PlexLibraryItem);
            }
          }
        }
      }

      return allEpisodes;
    } catch (error) {
      logger.warn(`Failed to get episodes for show ${showRatingKey}`, {
        label: 'Plex API',
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  public async getRecentlyAdded(
    id: string,
    options: { addedAt: number } = {
      addedAt: Date.now() - 1000 * 60 * 60,
    },
    mediaType: 'movie' | 'show'
  ): Promise<PlexLibraryItem[]> {
    return this.getRecentlyAddedByType(
      id,
      options,
      mediaType === 'show' ? 2 : 1
    );
  }

  /**
   * Fetch recently added items for an exact Plex metadata type.
   * 1=movie, 2=show, 3=season, 4=episode.
   */
  public async getRecentlyAddedByType(
    id: string,
    options: { addedAt: number },
    type: 1 | 2 | 3 | 4
  ): Promise<PlexLibraryItem[]> {
    const response = await this.plexClient.query<PlexLibraryResponse>({
      uri: `/library/sections/${id}/all?type=${type}&includeGuids=1&sort=addedAt%3Adesc&addedAt>>=${Math.floor(
        options.addedAt / 1000
      )}`,
      extraHeaders: {
        'X-Plex-Container-Start': `0`,
        'X-Plex-Container-Size': `500`,
      },
    });

    return response.MediaContainer.Metadata ?? [];
  }

  public async getAllCollections(): Promise<PlexCollection[]> {
    logger.debug('Fetching all Plex collections', { label: 'Plex API' });
    const startTime = Date.now();
    const allCollections: PlexCollection[] = [];

    try {
      const allLibraries = await this.getLibraries();
      // Filter to only movie and show libraries - we don't manage music, photo, or other library types
      const libraries = allLibraries.filter(
        (library) => library.type === 'movie' || library.type === 'show'
      );
      logger.debug('Processing collections across libraries', {
        label: 'Plex API',
        libraryCount: libraries.length,
      });

      for (const library of libraries) {
        try {
          const response = await this.plexClient.query<PlexCollectionResponse>({
            uri: `/library/sections/${library.key}/collections`,
            extraHeaders: {
              'X-Plex-Container-Size': `0`,
            },
          });

          const collections = response.MediaContainer?.Metadata || [];

          for (const collection of collections) {
            const detailedCollection = await this.getCollectionMetadata(
              collection.ratingKey
            );
            const labels = detailedCollection?.labels || [];

            const enhancedCollection: PlexCollection = {
              ...collection,
              libraryKey: library.key,
              libraryName: library.title,
              labels,
              titleSort: detailedCollection?.titleSort,
              collectionSort: detailedCollection?.collectionSort,
            };

            allCollections.push(enhancedCollection);
          }
        } catch (error) {
          logger.warn(
            `Failed to get collections for library ${library.title}`,
            {
              label: 'Plex API',
              error,
            }
          );
        }
      }
    } catch (error) {
      logger.error('Error getting all collections.', {
        label: 'Plex API',
        error,
      });
    }

    // Collections fetched from Plex
    logger.debug('All collections fetched successfully', {
      label: 'Plex API',
      collectionCount: allCollections.length,
      responseTime: Date.now() - startTime,
    });

    // Return collections in Plex's natural order - don't force addedAt sorting
    return allCollections;
  }

  public async getCollectionMetadata(
    ratingKey: string
  ): Promise<PlexCollectionMetadata | null> {
    try {
      const response = await this.plexClient.query<{
        MediaContainer: { Metadata: PlexCollectionMetadata[] };
      }>(`/library/metadata/${ratingKey}`);

      const collection = response.MediaContainer?.Metadata?.[0];
      if (!collection) {
        // Collection not found - this is different from an API error
        logger.debug(`Collection ${ratingKey} not found`, {
          label: 'Plex API',
        });
        return null;
      }

      const labels = this.parseLabelsFromCollection(collection);

      return {
        ...collection,
        labels,
      };
    } catch (error) {
      logger.error(`Failed to get collection metadata for ${ratingKey}`, {
        label: 'Plex API',
        error,
      });
      // Throw error to distinguish from "collection not found"
      throw new Error(
        `API error getting collection metadata: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Safely get collection metadata with error handling
   * Returns null for both "not found" and "API error" cases, but logs appropriately
   */
  public async getCollectionMetadataSafe(
    ratingKey: string
  ): Promise<PlexCollectionMetadata | null> {
    try {
      return await this.getCollectionMetadata(ratingKey);
    } catch (error) {
      // API error already logged in getCollectionMetadata
      return null;
    }
  }

  private parseLabelsFromCollection(collection: PlexCollection): string[] {
    // Handle multiple possible label structures from Plex API
    if (Array.isArray(collection.Label)) {
      return collection.Label.map((label) => label.tag).filter(
        (tag): tag is string => typeof tag === 'string'
      );
    }

    // Fallback: check if labels are already processed and stored in the labels property
    if (Array.isArray(collection.labels)) {
      return collection.labels;
    }

    return [];
  }

  public async getItemsByRatingKeys(
    ratingKeys: string[]
  ): Promise<PlexCollectionItem[]> {
    if (ratingKeys.length === 0) {
      return [];
    }

    try {
      // Use bulk fetching with comma-separated rating keys (like Python PlexAPI)
      const ratingKeysParam = ratingKeys.join(',');
      const response = await this.plexClient.query(
        `/library/metadata/${ratingKeysParam}`
      );

      const items = response.MediaContainer?.Metadata || [];

      // CRITICAL: Preserve the original order from ratingKeys array
      // Plex returns items in alphabetical order, but we need chronological request order
      const orderedItems: PlexCollectionItem[] = [];
      const missingRatingKeys: string[] = [];

      for (const ratingKey of ratingKeys) {
        const item = items.find(
          (item: PlexCollectionItem) => item.ratingKey === ratingKey
        );
        if (item) {
          orderedItems.push(item);
        } else {
          missingRatingKeys.push(ratingKey);
        }
      }

      if (missingRatingKeys.length > 0) {
        logger.warn(
          `${missingRatingKeys.length}/${ratingKeys.length} items could not be found in Plex library.`,
          {
            label: 'Plex API',
            totalRequested: ratingKeys.length,
            totalFound: items.length,
            missingRatingKeys: missingRatingKeys,
          }
        );
      }

      return orderedItems;
    } catch (error) {
      // If bulk fetch fails, fall back to individual requests
      logger.warn('Bulk fetch failed, falling back to individual requests.', {
        label: 'Plex API',
      });

      const items: PlexCollectionItem[] = [];
      const failedRatingKeys: string[] = [];

      for (const ratingKey of ratingKeys) {
        try {
          const response = await this.plexClient.query(
            `/library/metadata/${ratingKey}`
          );
          if (response.MediaContainer?.Metadata?.[0]) {
            items.push(response.MediaContainer.Metadata[0]);
          } else {
            failedRatingKeys.push(ratingKey);
          }
        } catch {
          failedRatingKeys.push(ratingKey);
        }
      }

      if (failedRatingKeys.length > 0) {
        logger.warn(
          `${failedRatingKeys.length}/${ratingKeys.length} items could not be found in Plex library.`,
          {
            label: 'Plex API',
            totalRequested: ratingKeys.length,
            totalFound: items.length,
            missingRatingKeys: failedRatingKeys,
          }
        );
      }

      return items;
    }
  }

  public async getCollectionByName(
    name: string,
    libraryKey: string
  ): Promise<PlexCollection | null> {
    try {
      const response = await this.plexClient.query<PlexCollectionResponse>({
        uri: `/library/sections/${libraryKey}/collections`,
        extraHeaders: {
          'X-Plex-Container-Size': `0`,
        },
      });
      const collections = response.MediaContainer?.Metadata || [];

      const foundCollection =
        collections.find(
          (collection: PlexCollection) => collection.title === name
        ) || null;

      if (foundCollection) {
        const detailedCollection = await this.getCollectionMetadata(
          foundCollection.ratingKey
        );
        const labels = detailedCollection?.labels || [];

        return {
          ...foundCollection,
          libraryKey,
          labels,
        };
      }

      return null;
    } catch (error) {
      logger.error(`Error getting collection by name "${name}"`, {
        label: 'Plex API',
        error,
      });
      return null;
    }
  }

  public async createEmptyCollection(
    title: string,
    libraryKey: string,
    mediaType: 'movie' | 'tv' = 'movie',
    containsEpisodes = false
  ): Promise<string | null> {
    try {
      // Use correct type parameter: 1 for movies, 2 for TV shows, 4 for episodes
      let typeParam: number;
      if (containsEpisodes) {
        typeParam = 4; // Episode collections
      } else {
        typeParam = mediaType === 'tv' ? 2 : 1; // TV show or movie collections
      }

      const createUrl = `/library/collections?type=${typeParam}&title=${encodeURIComponent(
        title
      )}&smart=0&sectionId=${libraryKey}`;

      const result = await this.safePostQuery(createUrl);

      let collectionRatingKey: string | null = null;
      if (result && typeof result === 'object' && 'MediaContainer' in result) {
        const resultObj = result as {
          MediaContainer?: {
            Metadata?: Record<string, unknown>[];
          };
        };
        const metadata = resultObj.MediaContainer?.Metadata?.[0];
        if (metadata) {
          // Handle both JSON (flat properties) and xml2js (nested under .attributes)
          collectionRatingKey =
            (metadata.ratingKey as string) ||
            (metadata.attributes as Record<string, string> | undefined)
              ?.ratingKey ||
            null;
        }
      }

      if (!collectionRatingKey) {
        logger.warn(
          `POST to create collection "${title}" returned no ratingKey — verifying via lookup`,
          {
            label: 'Plex API',
            title,
            libraryKey,
            resultType: typeof result,
            hasMediaContainer:
              result &&
              typeof result === 'object' &&
              'MediaContainer' in result,
          }
        );

        // Plex may have created the collection but returned an unparseable
        // response (e.g. charset in Content-Type breaks plex-api's strict
        // equality check, or XML response nests ratingKey differently).
        // Confirm by looking up the collection we just asked Plex to create.
        const found = await this.getCollectionByName(title, libraryKey);
        if (found) {
          collectionRatingKey = found.ratingKey;
          logger.info(
            `Recovered ratingKey ${collectionRatingKey} for "${title}" via title lookup`,
            { label: 'Plex API' }
          );
        }
      }

      return collectionRatingKey;
    } catch (error) {
      logger.error(`Error creating collection "${title}"`, {
        label: 'Plex API',
        title,
        libraryKey,
        mediaType,
        typeParam: mediaType === 'tv' ? 2 : 1,
        createUrl: `/library/collections?type=${
          mediaType === 'tv' ? 2 : 1
        }&title=${encodeURIComponent(title)}&smart=0&sectionId=${libraryKey}`,
        error:
          error instanceof Error
            ? {
                message: error.message,
                stack: error.stack,
                name: error.name,
              }
            : error,
      });
      return null;
    }
  }

  // Reads the collection back and counts how many of `attemptedKeys` actually
  // landed. Only call this after a write that claims success - a failed write
  // is already a known failure and doesn't need a second API call to prove it.
  private async verifyItemsLanded(
    collectionRatingKey: string,
    attemptedKeys: Set<string>
  ): Promise<number> {
    if (attemptedKeys.size === 0) {
      return 0;
    }

    const currentItems = await this.getCollectionItems(collectionRatingKey);
    const currentSet = new Set(currentItems);
    let verified = 0;
    for (const key of attemptedKeys) {
      if (currentSet.has(key)) {
        verified++;
      }
    }

    if (verified < attemptedKeys.size) {
      logger.warn(
        `addItemsToCollection: read-back verification found fewer items than the write claimed`,
        {
          label: 'Plex API',
          collectionRatingKey,
          attempted: attemptedKeys.size,
          verified,
        }
      );
    }

    return verified;
  }

  public async addItemsToCollection(
    collectionRatingKey: string,
    items: PlexCollectionItem[]
  ): Promise<{ successful: number; failed: number }> {
    if (items.length === 0) {
      return { successful: 0, failed: 0 };
    }

    // PROTECTION: Never add items to smart collections - they are auto-populated by Plex.
    // Treat an unknown status (transport failure) the same as smart: refuse.
    const smartStatus = await this.isSmartCollection(collectionRatingKey);
    if (smartStatus !== 'not_smart') {
      logger.error(
        `PROTECTION: Attempted to add items to smart collection ${collectionRatingKey}. This could corrupt the Plex database!`,
        {
          label: 'Plex API',
          collectionRatingKey,
          itemCount: items.length,
          smartStatus,
          protection: 'SMART_COLLECTION_BLOCK',
        }
      );
      throw new Error(
        `Cannot add items to smart collection ${collectionRatingKey}. Smart collections are auto-populated by Plex.`
      );
    }

    const machineId = getSettings().plex.machineId;

    // Check if any items are episodes by querying their metadata
    let hasEpisodes = false;
    if (items.length <= 5) {
      // Only check first few items for performance
      try {
        const itemChecks = await Promise.all(
          items.slice(0, 3).map(async (item) => {
            try {
              const response = await this.plexClient.query(
                `/library/metadata/${item.ratingKey}`
              );
              const metadata = response.MediaContainer?.Metadata?.[0];
              return metadata?.type === 'episode';
            } catch {
              return false;
            }
          })
        );
        hasEpisodes = itemChecks.some((isEpisode) => isEpisode);
      } catch {
        // If we can't check, assume no episodes
        hasEpisodes = false;
      }
    }

    try {
      // Use bulk addition with comma-separated rating keys
      const ratingKeys = items.map((item) => item.ratingKey).join(',');
      const uriParam = `server://${machineId}/com.plexapp.plugins.library/library/metadata/${ratingKeys}`;
      let addUrl = `/library/collections/${collectionRatingKey}/items?uri=${encodeURIComponent(
        uriParam
      )}`;

      // Add type=4 parameter for episode collections
      if (hasEpisodes) {
        addUrl += '&type=4';
      }

      await this.safePutQuery(addUrl);

      const requestedKeys = new Set(items.map((item) => item.ratingKey));
      const verified = await this.verifyItemsLanded(
        collectionRatingKey,
        requestedKeys
      );
      return { successful: verified, failed: items.length - verified };
    } catch (error) {
      // If bulk addition fails, fall back to individual addition
      logger.warn(
        'Bulk item addition failed, falling back to individual addition.',
        {
          label: 'Plex API',
          collectionRatingKey,
        }
      );

      let failed = 0;
      const addedKeys = new Set<string>();

      for (const item of items) {
        try {
          const uriParam = `server://${machineId}/com.plexapp.plugins.library/library/metadata/${item.ratingKey}`;
          let addUrl = `/library/collections/${collectionRatingKey}/items?uri=${encodeURIComponent(
            uriParam
          )}`;

          // Add type=4 parameter for episode collections (reuse the hasEpisodes check from above)
          if (hasEpisodes) {
            addUrl += '&type=4';
          }

          await this.safePutQuery(addUrl);
          addedKeys.add(item.ratingKey);
        } catch (itemError) {
          failed++;
          const errorMessage =
            itemError instanceof Error ? itemError.message : 'Unknown error';
          logger.warn(
            `Failed to add item "${item.title || 'Unknown'}" to collection.`,
            {
              label: 'Plex API',
              itemRatingKey: item.ratingKey,
              collectionRatingKey,
              error: errorMessage,
            }
          );
        }
      }

      if (addedKeys.size === 0) {
        return { successful: 0, failed };
      }

      const verified = await this.verifyItemsLanded(
        collectionRatingKey,
        addedKeys
      );
      return { successful: verified, failed: items.length - verified };
    }
  }

  /**
   * Get items in a collection
   */
  public async getCollectionItems(
    collectionRatingKey: string
  ): Promise<string[]> {
    try {
      const response = await this.plexClient.query({
        uri: `/library/collections/${collectionRatingKey}/children`,
        extraHeaders: {
          'X-Plex-Container-Size': `0`,
        },
      });
      const items = response.MediaContainer?.Metadata || [];
      return items.map((item: PlexCollectionItem) => item.ratingKey);
    } catch (error) {
      logger.error(
        `Error getting items from collection ${collectionRatingKey}`,
        {
          label: 'Plex API',
          error,
        }
      );
      return [];
    }
  }

  /**
   * Get full metadata for items in a collection, including Guid array for TMDB IDs
   * This is specifically for collections (smart or regular) - NOT for regular metadata items
   */
  public async getCollectionItemsWithMetadata(
    collectionRatingKey: string
  ): Promise<PlexMetadata[]> {
    try {
      const response = await this.plexClient.query({
        uri: `/library/collections/${collectionRatingKey}/children?includeGuids=1`,
        extraHeaders: {
          'X-Plex-Container-Size': `0`,
        },
      });
      return response.MediaContainer?.Metadata || [];
    } catch (error) {
      logger.error(
        `Error getting metadata from collection ${collectionRatingKey}`,
        {
          label: 'Plex API',
          error,
        }
      );
      return [];
    }
  }

  public async removeItemsFromCollection(
    collectionRatingKey: string
  ): Promise<void> {
    // PROTECTION: Never remove items from smart collections - they are auto-populated by Plex.
    // Treat an unknown status (transport failure) the same as smart: refuse.
    const smartStatus = await this.isSmartCollection(collectionRatingKey);
    if (smartStatus !== 'not_smart') {
      logger.error(
        `PROTECTION: Attempted to remove items from smart collection ${collectionRatingKey}. This could corrupt the Plex database!`,
        {
          label: 'Plex API',
          collectionRatingKey,
          smartStatus,
          protection: 'SMART_COLLECTION_BLOCK',
        }
      );
      throw new Error(
        `Cannot remove items from smart collection ${collectionRatingKey}. Smart collections are auto-populated by Plex.`
      );
    }

    try {
      const response = await this.plexClient.query({
        uri: `/library/collections/${collectionRatingKey}/children`,
        extraHeaders: {
          'X-Plex-Container-Size': `0`,
        },
      });
      const items = response.MediaContainer?.Metadata || [];

      if (items.length === 0) {
        return;
      }

      for (const item of items) {
        const removeUrl = `/library/collections/${collectionRatingKey}/items/${item.ratingKey}`;

        try {
          await this.safeDeleteQuery(removeUrl);
        } catch (error) {
          const errorMessage = (error as Error).message;
          if (!errorMessage.includes('404')) {
            logger.warn(
              `Failed to remove item ${item.ratingKey} from collection`,
              {
                label: 'Plex API',
                error: errorMessage,
              }
            );
          }
        }
      }
    } catch (error) {
      logger.error(
        `Error removing items from collection ${collectionRatingKey}`,
        {
          label: 'Plex API',
          error,
        }
      );
      throw error;
    }
  }

  public async addLabelToCollection(
    collectionRatingKey: string,
    label: string
  ): Promise<boolean> {
    return this.addLabelToCollectionWithRetry(collectionRatingKey, label, 3);
  }

  /**
   * Add label to collection with retry logic and verification
   */
  private async addLabelToCollectionWithRetry(
    collectionRatingKey: string,
    label: string,
    maxRetries: number
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Get current collection metadata to preserve existing labels
        // Use strict version to distinguish API errors from "not found"
        const collectionMeta = await this.getCollectionMetadata(
          collectionRatingKey
        );
        if (!collectionMeta) {
          throw new Error(`Collection ${collectionRatingKey} not found`);
        }

        // A stale or mispointed ratingKey can name a movie or show rather than a
        // collection. Labelling it would strip that item's other Agregarr labels
        // (see cleanAgregarrCollectionLabels) and leave a locked label behind,
        // so refuse instead. The caller finds out the key is wrong when its next
        // collection-scoped write returns 404.
        //
        // Only refuse on a type we actually read. If Plex ever omits it, fall
        // through and label as before: a missing field must not silently stop
        // Agregarr labelling every collection it owns.
        if (collectionMeta.type && collectionMeta.type !== 'collection') {
          logger.warn(
            `Refusing to label ${collectionRatingKey}: it is a ${collectionMeta.type}, not a collection`,
            { label: 'Plex API', collectionRatingKey }
          );
          return false;
        }

        // Check if label already exists first (case-insensitive comparison since Plex auto-formats labels)
        const existingLabels = collectionMeta.labels || [];
        const labelExistsIndex = existingLabels.findIndex(
          (existingLabel) => existingLabel.toLowerCase() === label.toLowerCase()
        );
        if (labelExistsIndex !== -1) {
          return true; // Early return - no changes needed
        }

        // Clean existing Agregarr labels while preserving user's custom labels
        // Only remove OTHER Agregarr labels, not the one we're trying to add
        const { cleanAgregarrCollectionLabels } = await import(
          '@server/lib/collections/core/CollectionUtilities'
        );
        const preservedLabels = cleanAgregarrCollectionLabels(
          existingLabels,
          label
        );

        // Combine preserved labels with new Agregarr label
        const allLabels = [...preservedLabels, label];

        // Build params with all labels to preserve existing ones
        const params: Record<string, string | number> = {
          'label.locked': 1,
        };

        // Add each label as a separate parameter
        allLabels.forEach((labelTag, index) => {
          params[`label[${index}].tag.tag`] = labelTag;
        });

        const queryString = Object.entries(params)
          .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
          .join('&');

        const editUrl = `/library/metadata/${collectionRatingKey}?${queryString}`;

        await this.safePutQuery(editUrl);
        this.recordWrite('label');

        // Verify the label was actually added (with a small delay for Plex API)
        await new Promise((resolve) => setTimeout(resolve, 500)); // Allow Plex time to index the label
        const updatedMeta = await this.getCollectionMetadata(
          collectionRatingKey
        );

        if (
          !updatedMeta ||
          !updatedMeta.labels?.some(
            (existingLabel) =>
              existingLabel.toLowerCase() === label.toLowerCase()
          )
        ) {
          // Don't fail immediately - Plex might need more time to index labels
          logger.warn(
            `Label verification delayed for collection ${collectionRatingKey} - label "${label}" not immediately visible`,
            {
              label: 'Plex API',
              foundLabels: updatedMeta?.labels || [],
              expectedLabel: label,
            }
          );

          // Give Plex more time and try once more
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const finalMeta = await this.getCollectionMetadata(
            collectionRatingKey
          );

          if (
            !finalMeta ||
            !finalMeta.labels?.some(
              (existingLabel) =>
                existingLabel.toLowerCase() === label.toLowerCase()
            )
          ) {
            throw new Error(
              `Label verification failed - label "${label}" not found on collection after multiple attempts. Found labels: ${JSON.stringify(
                finalMeta?.labels || []
              )}`
            );
          }
        }

        return true;
      } catch (error) {
        logger.warn(
          `Attempt ${attempt}/${maxRetries} failed to add label "${label}" to collection ${collectionRatingKey}`,
          {
            label: 'Plex API',
            error: error instanceof Error ? error.message : 'Unknown error',
            attempt,
            maxRetries,
          }
        );

        if (attempt === maxRetries) {
          logger.error(
            `Failed to add label "${label}" to collection ${collectionRatingKey} after ${maxRetries} attempts`,
            {
              label: 'Plex API',
              error,
            }
          );
          return false;
        }

        // Wait before retrying (exponential backoff)
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
    return false;
  }

  public async updateCollectionTitle(
    collectionRatingKey: string,
    title: string,
    libraryKey?: string,
    currentTitle?: string
  ): Promise<void> {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      logger.warn(
        `Skipping empty title update for collection ${collectionRatingKey}`,
        { label: 'Plex API', collectionRatingKey }
      );
      return;
    }
    if (
      currentTitle !== undefined &&
      normalizedTitle === currentTitle &&
      this.shouldSkipUnchangedWrites()
    ) {
      return;
    }
    try {
      // Use the correct Plex API endpoint for editing collection metadata
      // Collections require PUT /library/sections/{libraryKey}/all with type=18
      // The old endpoint /library/metadata/{ratingKey} doesn't reliably update collection titles
      if (libraryKey) {
        const editUrl = `/library/sections/${libraryKey}/all?type=18&id=${collectionRatingKey}&title.value=${encodeURIComponent(
          normalizedTitle
        )}&title.locked=1`;
        await this.safePutQuery(editUrl);
        this.recordWrite('title');
      } else {
        // Fallback to old method if libraryKey not provided (for backwards compatibility)
        // This may not work reliably for collections
        const params = {
          'title.value': normalizedTitle,
        };

        const queryString = Object.entries(params)
          .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
          .join('&');

        const editUrl = `/library/metadata/${collectionRatingKey}?${queryString}`;

        await this.safePutQuery(editUrl);
        this.recordWrite('title');

        logger.warn(
          `updateCollectionTitle called without libraryKey - using legacy endpoint which may not work for collections`,
          {
            label: 'Plex API',
            collectionRatingKey,
          }
        );
      }
    } catch (error) {
      logger.error(
        `Error updating title for collection ${collectionRatingKey}`,
        {
          label: 'Plex API',
          error,
        }
      );
      throw error; // Re-throw so callers know the update failed
    }
  }

  /**
   * Update collection mode (visibility of individual items)
   * @param collectionRatingKey - Collection rating key
   * @param mode - Collection mode: -1 = inherit library default, 0 = library default, 1 = hide items show collection, 2 = show collection and items, 3 = hide collection show items
   */
  public async updateCollectionMode(
    collectionRatingKey: string,
    mode: -1 | 0 | 1 | 2 | 3
  ): Promise<void> {
    try {
      // Plex uses /prefs endpoint with collectionMode query parameter
      const prefsUrl = `/library/metadata/${collectionRatingKey}/prefs?collectionMode=${mode}`;

      await this.safePutQuery(prefsUrl);
      this.recordWrite('mode');

      logger.debug(
        `Updated collection mode to ${mode} for collection ${collectionRatingKey}`,
        {
          label: 'Plex API',
          mode,
          collectionRatingKey,
        }
      );
    } catch (error) {
      logger.error(
        `Error updating collection mode for collection ${collectionRatingKey}`,
        {
          label: 'Plex API',
          error,
        }
      );
    }
  }

  /**
   * Update the title of an individual item (movie, show, episode)
   */
  public async updateItemTitle(
    ratingKey: string,
    title: string
  ): Promise<void> {
    try {
      const params = {
        'title.value': title,
        'title.locked': '1', // Lock to prevent Plex from overwriting
      };

      const queryString = Object.entries(params)
        .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
        .join('&');

      const editUrl = `/library/metadata/${ratingKey}?${queryString}`;

      await this.safePutQuery(editUrl);

      logger.debug('Updated item title', {
        label: 'Plex API',
        ratingKey,
        title,
      });
    } catch (error) {
      logger.error(`Error updating title for item ${ratingKey}`, {
        label: 'Plex API',
        error,
      });
      throw error;
    }
  }

  /**
   * Add a label to an individual item (movie, show, episode)
   */
  public async addLabelToItem(
    ratingKey: string,
    label: string,
    maxAttempts = 2
  ): Promise<void> {
    const attempts = Math.max(1, maxAttempts);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        // Get current item metadata to preserve existing labels
        const metadata = await this.getMetadata(ratingKey);

        // Get existing labels
        const existingLabels: string[] = [];
        if (metadata && 'Label' in metadata) {
          const labels = metadata.Label as { tag: string }[] | undefined;
          if (labels && Array.isArray(labels)) {
            existingLabels.push(...labels.map((l) => l.tag));
          }
        }

        // Check if label already exists
        if (existingLabels.includes(label)) {
          logger.debug('Label already exists on item', {
            label: 'Plex API',
            ratingKey,
            labelTag: label,
          });
          return;
        }

        // Build params with all labels (existing + new)
        const allLabels = [...existingLabels, label];
        const params: Record<string, string> = {};
        allLabels.forEach((labelTag, index) => {
          params[`label[${index}].tag.tag`] = labelTag;
        });

        const queryString = Object.entries(params)
          .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
          .join('&');

        const editUrl = `/library/metadata/${ratingKey}?${queryString}`;

        await this.safePutQuery(editUrl);

        if (attempt > 1) {
          logger.info(`Label applied on retry for ${ratingKey}`, {
            label: 'Plex API',
            labelTag: label,
            attempt,
          });
        } else {
          logger.debug('Added label to item', {
            label: 'Plex API',
            ratingKey,
            labelTag: label,
          });
        }
        return;
      } catch (error) {
        if (attempt < attempts) {
          logger.warn(`Label apply failed for ${ratingKey}, retrying in 1s`, {
            label: 'Plex API',
            attempt,
            error: error instanceof Error ? error.message : String(error),
          });
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } else {
          logger.error(
            `Error adding label to item ${ratingKey} (after ${attempts} attempts)`,
            {
              label: 'Plex API',
              error,
            }
          );
          throw error;
        }
      }
    }
  }

  /**
   * Remove a label from an individual item (movie, show, episode)
   */
  public async removeLabelFromItem(
    ratingKey: string,
    label: string
  ): Promise<void> {
    try {
      // Get current item metadata to check existing labels
      const metadata = await this.getMetadata(ratingKey);

      // Get existing labels
      const existingLabels: string[] = [];
      if (metadata && 'Label' in metadata) {
        const labels = metadata.Label as { tag: string }[] | undefined;
        if (labels && Array.isArray(labels)) {
          existingLabels.push(...labels.map((l) => l.tag));
        }
      }

      // Remove ALL case-insensitive matches (handles duplicates with different casing)
      const updatedLabels = existingLabels.filter(
        (existingLabel) => existingLabel.toLowerCase() !== label.toLowerCase()
      );

      if (updatedLabels.length === existingLabels.length) {
        logger.debug('Label does not exist on item, nothing to remove', {
          label: 'Plex API',
          ratingKey,
          labelTag: label,
        });
        return;
      }

      // Build params with remaining labels
      const params: Record<string, string> = {};
      updatedLabels.forEach((labelTag, index) => {
        params[`label[${index}].tag.tag`] = labelTag;
      });

      // If no labels remain, we still need to send the request to clear all labels
      const queryString =
        updatedLabels.length > 0
          ? Object.entries(params)
              .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
              .join('&')
          : 'label[0].tag.tag-=';

      const editUrl = `/library/metadata/${ratingKey}?${queryString}`;

      await this.safePutQuery(editUrl);

      logger.debug('Removed label from item', {
        label: 'Plex API',
        ratingKey,
        labelTag: label,
        remainingLabels: updatedLabels,
      });
    } catch (error) {
      logger.error(`Error removing label from item ${ratingKey}`, {
        label: 'Plex API',
        error,
      });
      throw error;
    }
  }

  /**
   * Get all items in a library that have a specific label
   * @param libraryKey - Library section key
   * @param labelName - Label to search for
   * @returns Array of rating keys for items with the label
   */
  public async getItemsWithLabel(
    libraryKey: string,
    labelName: string
  ): Promise<string[]> {
    try {
      const response = await this.plexClient.query<{
        MediaContainer?: { Metadata?: { ratingKey: string }[] };
      }>({
        uri: `/library/sections/${libraryKey}/all?label=${encodeURIComponent(
          labelName
        )}`,
        extraHeaders: {
          'X-Plex-Container-Size': `0`,
        },
      });

      const items = response.MediaContainer?.Metadata || [];
      return items.map((item) => item.ratingKey);
    } catch (error) {
      logger.error(
        `Error getting items with label "${labelName}" in library ${libraryKey}`,
        {
          label: 'Plex API',
          libraryKey,
          labelName,
          error,
        }
      );
      return [];
    }
  }

  public async updateCollectionSortTitle(
    collectionRatingKey: string,
    sortTitle: string,
    currentTitleSort?: string
  ): Promise<void> {
    if (
      currentTitleSort !== undefined &&
      sortTitle === currentTitleSort &&
      this.shouldSkipUnchangedWrites()
    ) {
      return;
    }
    try {
      const params = {
        type: 18,
        id: collectionRatingKey,
        'titleSort.value': sortTitle,
        'titleSort.locked': 1,
      };

      const queryString = Object.entries(params)
        .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
        .join('&');

      const editUrl = `/library/metadata/${collectionRatingKey}?${queryString}`;

      await this.safePutQuery(editUrl);
      this.recordWrite('sortTitle');
    } catch (error) {
      logger.error(
        `Error updating sort title for collection ${collectionRatingKey}`,
        {
          label: 'Plex API',
          error,
        }
      );
    }
  }

  public async updateCollectionContentSort(
    collectionRatingKey: string,
    sortType: 'release' | 'alpha' | 'custom' = 'custom',
    currentSort?: string
  ): Promise<void> {
    try {
      // Map sort types to Plex integer values (from Python PlexAPI reverse engineering)
      const sortValues = {
        release: 0, // Order by release dates
        alpha: 1, // Order alphabetically
        custom: 2, // Custom collection order (preserves add order)
      };

      const desiredSort = sortValues[sortType];
      if (
        currentSort !== undefined &&
        String(desiredSort) === String(currentSort) &&
        this.shouldSkipUnchangedWrites()
      ) {
        return;
      }

      // Use the correct endpoint discovered from Python PlexAPI debug output:
      // PUT /library/collections/{ratingKey}/prefs?collectionSort=2
      const editUrl = `/library/collections/${collectionRatingKey}/prefs?collectionSort=${desiredSort}`;

      await this.safePutQuery(editUrl);
      this.recordWrite('contentSort');
    } catch (error) {
      logger.error(
        `Error updating content sort for collection ${collectionRatingKey}`,
        {
          label: 'Plex API',
          error,
        }
      );
      throw error;
    }
  }

  public async moveItemInCollection(
    collectionRatingKey: string,
    itemRatingKey: string,
    afterItemRatingKey: string
  ): Promise<boolean> {
    // PROTECTION: Never move items in smart collections - they have their own ordering.
    // Treat an unknown status (transport failure) the same as smart: refuse.
    const smartStatus = await this.isSmartCollection(collectionRatingKey);
    if (smartStatus !== 'not_smart') {
      logger.debug(
        `PROTECTION: Attempted to move item in smart collection ${collectionRatingKey}. Skipping move for smart collection.`,
        {
          label: 'Plex API',
          collectionRatingKey,
          itemRatingKey,
          smartStatus,
          protection: 'SMART_COLLECTION_SKIP',
        }
      );
      return false; // Just return false for smart collections, don't throw error
    }

    try {
      // Use the exact API endpoint discovered from Python PlexAPI debug output:
      // PUT /library/collections/{collectionRatingKey}/items/{itemRatingKey}/move?after={afterItemRatingKey}
      const moveUrl = `/library/collections/${collectionRatingKey}/items/${itemRatingKey}/move?after=${afterItemRatingKey}`;

      await this.safePutQuery(moveUrl);
      this.recordWrite('arrange');
      return true;
    } catch (error) {
      // Silently fail - this is not critical for functionality
      return false;
    }
  }

  public async arrangeCollectionItemsInOrder(
    collectionRatingKey: string,
    orderedItems: PlexCollectionItem[]
  ): Promise<void> {
    if (orderedItems.length <= 1) {
      return; // No need to arrange single item or empty collections
    }

    // PROTECTION: Never arrange items in smart collections - they have their own ordering.
    // Treat an unknown status (transport failure) the same as smart: refuse.
    const smartStatus = await this.isSmartCollection(collectionRatingKey);
    if (smartStatus !== 'not_smart') {
      logger.warn(
        `PROTECTION: Attempted to arrange items in smart collection ${collectionRatingKey}. Skipping arrangement for smart collection.`,
        {
          label: 'Plex API',
          collectionRatingKey,
          itemCount: orderedItems.length,
          smartStatus,
          protection: 'SMART_COLLECTION_SKIP',
        }
      );
      return; // Just skip arrangement for smart collections, don't throw error
    }

    // Fetch current order once
    const currentOrder = await this.getCollectionItems(collectionRatingKey);
    const desiredOrder = orderedItems.map((item) => item.ratingKey);

    // Early return optimization: Check if already in correct order
    if (
      currentOrder.length === desiredOrder.length &&
      currentOrder.every(
        (ratingKey, index) => ratingKey === desiredOrder[index]
      )
    ) {
      logger.debug(
        `Collection ${collectionRatingKey} is already in correct order. Skipping reordering.`,
        {
          label: 'Plex API',
          collectionRatingKey,
          itemCount: orderedItems.length,
        }
      );
      return;
    }

    let moveCount = 0;
    let failCount = 0;

    // Selective reordering: Only move items that are out of position
    for (let i = 0; i < desiredOrder.length; i++) {
      if (currentOrder[i] !== desiredOrder[i]) {
        const itemToMove = desiredOrder[i];

        let success = false;
        if (i === 0) {
          // Special case: position 0 - move without 'after' parameter
          try {
            const moveUrl = `/library/collections/${collectionRatingKey}/items/${itemToMove}/move`;
            await this.safePutQuery(moveUrl);
            this.recordWrite('arrange');
            success = true;
          } catch (error) {
            success = false;
          }
        } else {
          // Normal case: move after the previous item
          const afterItem = desiredOrder[i - 1];
          success = await this.moveItemInCollection(
            collectionRatingKey,
            itemToMove,
            afterItem
          );
        }

        if (success) {
          moveCount++;
          // Update in-memory tracking: remove from old position and insert at new position
          const oldIndex = currentOrder.indexOf(itemToMove);
          if (oldIndex !== -1) {
            currentOrder.splice(oldIndex, 1);
          }
          currentOrder.splice(i, 0, itemToMove);
        } else {
          failCount++;
        }
      }
    }

    if (moveCount > 0) {
      logger.debug(
        `Selectively moved ${moveCount} items in collection ${collectionRatingKey}`,
        {
          label: 'Plex API',
          collectionRatingKey,
          totalItems: orderedItems.length,
          movedItems: moveCount,
        }
      );
    }

    if (failCount > 0) {
      logger.warn(
        `Failed to arrange ${failCount} items in collection ${collectionRatingKey}`,
        {
          label: 'Plex API',
        }
      );
    }
  }

  public async updateCollectionVisibility(
    collectionRatingKey: string,
    recommended: boolean,
    home: boolean,
    shared: boolean
  ): Promise<void> {
    try {
      // Get collection metadata to determine library section
      const collectionMeta = await this.plexClient.query(
        `/library/metadata/${collectionRatingKey}`
      );
      const librarySectionID =
        collectionMeta.MediaContainer?.Metadata?.[0]?.librarySectionID;

      if (!librarySectionID) {
        throw new Error(
          `Could not determine library section ID for collection ${collectionRatingKey}`
        );
      }

      const hubIdentifier = `custom.collection.${librarySectionID}.${collectionRatingKey}`;

      // Only promote if not already in hub management — re-promoting resets
      // visibility to all-on, undoing any inactive visibility that was set.
      let alreadyManaged = false;
      let lookupSucceeded = false;
      let currentHub:
        | PlexHubManagementResponse['MediaContainer']['Hub'][number]
        | undefined;
      try {
        const hubMgmt = await this.hubManager.getHubManagement(
          librarySectionID
        );
        currentHub = hubMgmt.MediaContainer?.Hub?.find(
          (h: { identifier: string }) => h.identifier === hubIdentifier
        );
        alreadyManaged = currentHub !== undefined;
        lookupSucceeded = true;
      } catch {
        // Fall through to promote (same as pre-fix behaviour)
      }

      if (
        lookupSucceeded &&
        !alreadyManaged &&
        !recommended &&
        !home &&
        !shared
      ) {
        return;
      }

      if (!alreadyManaged) {
        const hubInitUrl = `/hubs/sections/${librarySectionID}/manage?metadataItemId=${collectionRatingKey}`;
        await this.safePostQuery(hubInitUrl);
        this.hubManager.clearHubManagementCache();
      } else if (
        currentHub &&
        currentHub.promotedToRecommended === recommended &&
        currentHub.promotedToOwnHome === home &&
        currentHub.promotedToSharedHome === shared &&
        this.shouldSkipUnchangedWrites()
      ) {
        return;
      }

      // Update visibility settings
      const params = new URLSearchParams({
        promotedToRecommended: recommended ? '1' : '0',
        promotedToOwnHome: home ? '1' : '0',
        promotedToSharedHome: shared ? '1' : '0',
      });

      const putUrl = `/hubs/sections/${librarySectionID}/manage/${hubIdentifier}?${params.toString()}`;
      await this.safePutQuery(putUrl);
    } catch (error) {
      logger.error(
        `Error updating visibility for collection ${collectionRatingKey}`,
        {
          label: 'Plex API',
          error: error instanceof Error ? error.message : String(error),
          collectionRatingKey,
          recommended,
          home,
          shared,
        }
      );
    }
  }

  /**
   * Remove specific items from a collection (incremental update)
   */
  public async removeSpecificItemsFromCollection(
    collectionRatingKey: string,
    itemsToRemove: string[]
  ): Promise<{ successful: number; failed: number }> {
    let successful = 0;
    let failed = 0;

    // PROTECTION: Never remove items from smart collections - they are auto-populated by Plex.
    // Treat an unknown status (transport failure) the same as smart: refuse.
    const smartStatus = await this.isSmartCollection(collectionRatingKey);
    if (smartStatus !== 'not_smart') {
      logger.error(
        `PROTECTION: Attempted to remove specific items from smart collection ${collectionRatingKey}. This could corrupt the Plex database!`,
        {
          label: 'Plex API',
          collectionRatingKey,
          itemCount: itemsToRemove.length,
          smartStatus,
          protection: 'SMART_COLLECTION_BLOCK',
        }
      );
      throw new Error(
        `Cannot remove items from smart collection ${collectionRatingKey}. Smart collections are auto-populated by Plex.`
      );
    }

    for (const ratingKey of itemsToRemove) {
      const removeUrl = `/library/collections/${collectionRatingKey}/items/${ratingKey}`;

      try {
        await this.safeDeleteQuery(removeUrl);
        successful++;
      } catch (error) {
        failed++;
        const errorMessage = (error as Error).message;
        if (!errorMessage.includes('404')) {
          logger.warn(
            `Failed to remove item ${ratingKey} from collection ${collectionRatingKey}`,
            {
              label: 'Plex API',
              error: errorMessage,
            }
          );
        }
      }
    }

    return { successful, failed };
  }

  /**
   * Incrementally update collection contents (preserve collection, update items only)
   * This replaces the delete/recreate approach with smart add/remove/reorder
   */
  public async updateCollectionContents(
    collectionRatingKey: string,
    desiredItems: PlexCollectionItem[]
  ): Promise<{
    added: number;
    removed: number;
    removedKeys: string[];
    reordered: boolean;
    errors: string[];
  }> {
    const errors: string[] = [];
    let added = 0;
    let removed = 0;
    let reordered = false;

    // PROTECTION: Never update smart collections - they are auto-populated by Plex.
    // Treat an unknown status (transport failure) the same as smart: refuse.
    const smartStatus = await this.isSmartCollection(collectionRatingKey);
    if (smartStatus !== 'not_smart') {
      logger.error(
        `PROTECTION: Attempted to update contents of smart collection ${collectionRatingKey}. This could corrupt the Plex database!`,
        {
          label: 'Plex API',
          collectionRatingKey,
          itemCount: desiredItems.length,
          smartStatus,
          protection: 'SMART_COLLECTION_BLOCK',
        }
      );
      throw new Error(
        `Cannot update smart collection ${collectionRatingKey}. Smart collections are auto-populated by Plex.`
      );
    }

    try {
      // Get current collection contents (returns array of rating keys)
      const currentRatingKeys = await this.getCollectionItems(
        collectionRatingKey
      );
      const currentRatingKeysSet = new Set(currentRatingKeys);
      const desiredRatingKeysSet = new Set(
        desiredItems.map((item) => item.ratingKey)
      );

      // Calculate what needs to be added and removed
      const toAdd = desiredItems.filter(
        (item) => !currentRatingKeysSet.has(item.ratingKey)
      );
      const toRemoveKeys = currentRatingKeys.filter(
        (ratingKey) => !desiredRatingKeysSet.has(ratingKey)
      );

      // Remove items that shouldn't be in the collection
      if (toRemoveKeys.length > 0) {
        const removeResult = await this.removeSpecificItemsFromCollection(
          collectionRatingKey,
          toRemoveKeys
        );
        removed = removeResult.successful;
        if (removeResult.failed > 0) {
          errors.push(`Failed to remove ${removeResult.failed} items`);
        }
      }

      // Add new items to the collection
      if (toAdd.length > 0) {
        const addResult = await this.addSpecificItemsToCollection(
          collectionRatingKey,
          toAdd.map((item) => item.ratingKey)
        );
        added = addResult.successful;
        if (addResult.failed > 0) {
          errors.push(`Failed to add ${addResult.failed} items`);
        }
      }

      // Always reorder items to match desired order for consistency
      if (desiredItems.length > 0) {
        try {
          await this.arrangeCollectionItemsInOrder(
            collectionRatingKey,
            desiredItems
          );
          reordered = true;
        } catch (error) {
          errors.push(
            `Failed to reorder collection: ${(error as Error).message}`
          );
        }
      }

      return { added, removed, removedKeys: toRemoveKeys, reordered, errors };
    } catch (error) {
      errors.push(`Collection update failed: ${(error as Error).message}`);
      return {
        added: 0,
        removed: 0,
        removedKeys: [],
        reordered: false,
        errors,
      };
    }
  }

  /**
   * Add specific items to a collection (incremental update)
   */
  public async addSpecificItemsToCollection(
    collectionRatingKey: string,
    itemsToAdd: string[]
  ): Promise<{ successful: number; failed: number }> {
    let successful = 0;
    let failed = 0;

    // PROTECTION: Never add items to smart collections - they are auto-populated by Plex.
    // Treat an unknown status (transport failure) the same as smart: refuse.
    const smartStatus = await this.isSmartCollection(collectionRatingKey);
    if (smartStatus !== 'not_smart') {
      logger.error(
        `PROTECTION: Attempted to add specific items to smart collection ${collectionRatingKey}. This could corrupt the Plex database!`,
        {
          label: 'Plex API',
          collectionRatingKey,
          itemCount: itemsToAdd.length,
          smartStatus,
          protection: 'SMART_COLLECTION_BLOCK',
        }
      );
      throw new Error(
        `Cannot add items to smart collection ${collectionRatingKey}. Smart collections are auto-populated by Plex.`
      );
    }

    // Validate all items exist before attempting to add them
    const validItems = await this.getItemsByRatingKeys(itemsToAdd);
    const validRatingKeys = validItems.map((item) => item.ratingKey);

    if (validRatingKeys.length === 0) {
      logger.warn(
        `No valid items to add to collection ${collectionRatingKey}`,
        {
          label: 'Plex API',
          requestedItems: itemsToAdd.length,
        }
      );
      return { successful: 0, failed: itemsToAdd.length };
    }

    // Check which items are already in the collection to avoid duplicate additions
    const currentItems = await this.getCollectionItems(collectionRatingKey);
    const currentItemsSet = new Set(currentItems);
    const itemsToActuallyAdd = validRatingKeys.filter(
      (key) => !currentItemsSet.has(key)
    );

    // Check what type of items these are and which library they belong to
    const itemTypes = await Promise.all(
      itemsToActuallyAdd.slice(0, 4).map(async (ratingKey) => {
        try {
          const response = await this.plexClient.query(
            `/library/metadata/${ratingKey}`
          );
          const item = response.MediaContainer?.Metadata?.[0];
          return {
            ratingKey,
            type: item?.type,
            title: item?.title,
            librarySectionID: item?.librarySectionID,
          };
        } catch {
          return {
            ratingKey,
            type: 'unknown',
            title: 'unknown',
            librarySectionID: 'unknown',
          };
        }
      })
    );

    // Also get the collection's library info
    let collectionLibrary = 'unknown';
    try {
      const collResponse = await this.plexClient.query(
        `/library/collections/${collectionRatingKey}`
      );
      collectionLibrary =
        collResponse.MediaContainer?.Metadata?.[0]?.librarySectionID ||
        'unknown';
    } catch (error) {
      logger.warn(
        `Failed to get collection library info for ${collectionRatingKey}`,
        {
          label: 'Plex API',
          error: error instanceof Error ? error.message : error,
        }
      );
    }

    const itemLibraries = Array.from(
      new Set(itemTypes.map((item) => item.librarySectionID))
    );
    const libraryMismatch =
      itemLibraries.length > 0 &&
      collectionLibrary !== 'unknown' &&
      !itemLibraries.includes(Number(collectionLibrary));

    if (libraryMismatch) {
      logger.error(
        `LIBRARY MISMATCH DETECTED: Collection ${collectionRatingKey} is in library ${collectionLibrary} but items are in libraries [${itemLibraries.join(
          ','
        )}]`,
        {
          label: 'Plex API',
          collectionLibrary,
          itemLibraries,
          collectionRatingKey,
        }
      );
    }

    logger.debug(`Collection ${collectionRatingKey} item analysis`, {
      label: 'Plex API',
      requestedItems: itemsToAdd.length,
      validItems: validRatingKeys.length,
      currentItems: currentItems.length,
      itemsToAdd: itemsToActuallyAdd.length,
      newItems: itemsToActuallyAdd,
      itemTypes: itemTypes,
      collectionLibrary: collectionLibrary,
    });

    if (itemsToActuallyAdd.length === 0) {
      logger.info(`All items already in collection ${collectionRatingKey}`, {
        label: 'Plex API',
        requestedItems: itemsToAdd.length,
        validItems: validRatingKeys.length,
      });
      return {
        successful: validRatingKeys.length,
        failed: itemsToAdd.length - validRatingKeys.length,
      };
    }

    // Add all items at once - no need for batching
    const machineId = getSettings().plex.machineId;
    const uri = `server://${machineId}/com.plexapp.plugins.library/library/metadata/${itemsToActuallyAdd.join(
      ','
    )}`;
    const addUrl = `/library/collections/${collectionRatingKey}/items?uri=${encodeURIComponent(
      uri
    )}`;

    // Check if we're adding episodes - if so, we might need special handling
    const hasEpisodes = itemTypes.some((item) => item.type === 'episode');

    try {
      if (hasEpisodes) {
        // For episodes, try adding the type=4 parameter
        const episodeAddUrl = `${addUrl}&type=4`;
        await this.safePutQuery(episodeAddUrl);
      } else {
        await this.safePutQuery(addUrl);
      }
      successful = itemsToActuallyAdd.length;
    } catch (error) {
      failed = itemsToActuallyAdd.length;
      logger.error(
        `Error adding ${itemsToActuallyAdd.length} items to collection ${collectionRatingKey}`,
        {
          label: 'Plex API',
          error: error instanceof Error ? error.message : error,
          itemCount: itemsToActuallyAdd.length,
          uri: uri.length > 200 ? uri.substring(0, 200) + '...' : uri,
        }
      );
    }

    // Account for items that were filtered out or already in collection
    const alreadyInCollection =
      validRatingKeys.length - itemsToActuallyAdd.length;
    const invalidItems = itemsToAdd.length - validRatingKeys.length;
    return {
      successful: successful + alreadyInCollection,
      failed: failed + invalidItems,
    };
  }

  public async deleteCollection(collectionRatingKey: string): Promise<void> {
    try {
      await this.safeDeleteQuery(`/library/collections/${collectionRatingKey}`);
    } catch (error) {
      logger.error(`Error deleting collection ${collectionRatingKey}.`, {
        label: 'Plex API',
        error,
      });
      throw error;
    }
  }

  /**
   * Trigger a Plex library scan/refresh
   * @param libraryId - The library section ID to scan
   * @param directory - Optional directory to limit the scan to. Must be a
   *   path as the Plex server sees it. Scoping the scan keeps unrelated
   *   unavailable items (e.g. a network mount that dropped) out of the trash.
   */
  public async scanLibrary(
    libraryId: string,
    directory?: string
  ): Promise<void> {
    try {
      logger.debug('Triggering Plex library scan', {
        label: 'Plex API',
        libraryId,
        directory,
      });

      await this.plexClient.query(
        directory
          ? `/library/sections/${libraryId}/refresh?path=${encodeURIComponent(
              directory
            )}`
          : `/library/sections/${libraryId}/refresh`
      );

      logger.info('Plex library scan triggered', {
        label: 'Plex API',
        libraryId,
        directory,
      });
    } catch (error) {
      logger.error('Failed to trigger Plex library scan', {
        label: 'Plex API',
        libraryId,
        directory,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get the filesystem locations of a library section, as the Plex server
   * sees them. Used to verify a directory-scoped scan will actually target
   * a path Plex knows about.
   * @param libraryId - The library section ID
   */
  public async getLibrarySectionPaths(libraryId: string): Promise<string[]> {
    try {
      const response = await this.plexClient.query<{
        MediaContainer: {
          Directory?: { Location?: { path: string }[] }[];
        };
      }>(`/library/sections/${libraryId}`);

      return (
        response.MediaContainer.Directory?.[0]?.Location?.map(
          (location) => location.path
        ) ?? []
      );
    } catch (error) {
      logger.warn('Failed to fetch Plex library section locations', {
        label: 'Plex API',
        libraryId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Check whether the Plex server empties trash automatically after every
   * scan ("Empty trash automatically after every scan" server setting).
   * When enabled, an explicit emptyTrash call after a scan is redundant.
   * Defaults to false on error so callers fall back to the explicit call.
   */
  public async getAutoEmptyTrashEnabled(): Promise<boolean> {
    if (!this.autoEmptyTrashPrefPromise) {
      this.autoEmptyTrashPrefPromise = (async () => {
        try {
          const response = await this.plexClient.query<{
            MediaContainer: {
              Setting?: { id: string; value: boolean | string }[];
            };
          }>('/:/prefs');

          const setting = response.MediaContainer.Setting?.find(
            (s) => s.id === 'autoEmptyTrash'
          );

          return setting?.value === true || setting?.value === 'true';
        } catch (error) {
          logger.warn('Failed to read Plex server preferences', {
            label: 'Plex API',
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        }
      })();
    }

    return this.autoEmptyTrashPrefPromise;
  }

  /**
   * Empty trash for a Plex library section
   * Removes items that Plex has detected as missing/unavailable
   * @param libraryId - The library section ID to empty trash for
   */
  public async emptyTrash(libraryId: string): Promise<void> {
    try {
      logger.debug('Emptying Plex library trash', {
        label: 'Plex API',
        libraryId,
      });

      await this.safePutQuery(`/library/sections/${libraryId}/emptyTrash`);

      logger.info('Plex library trash emptied', {
        label: 'Plex API',
        libraryId,
      });
    } catch (error) {
      logger.error('Failed to empty Plex library trash', {
        label: 'Plex API',
        libraryId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Delete a media item from Plex by its rating key
   * Use this for direct deletion when scan/emptyTrash won't work (e.g., empty directories)
   * @param ratingKey - The rating key of the item to delete
   */
  public async deleteItem(ratingKey: string): Promise<void> {
    try {
      logger.debug('Deleting Plex item', {
        label: 'Plex API',
        ratingKey,
      });

      await this.safeDeleteQuery(`/library/metadata/${ratingKey}`);

      logger.info('Plex item deleted', {
        label: 'Plex API',
        ratingKey,
      });
    } catch (error) {
      logger.error('Failed to delete Plex item', {
        label: 'Plex API',
        ratingKey,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Find Plex items that reference any of the given file paths
   * Scans the library once and matches against all paths for efficiency
   * @param libraryId - The library section ID to search in
   * @param filePaths - Set of exact file paths to search for
   * @returns Map of file path to rating keys for items referencing that path
   */
  public async findItemsByFilePaths(
    libraryId: string,
    filePaths: Set<string>,
    type?: number
  ): Promise<Map<string, string[]>> {
    const results = new Map<string, string[]>();

    if (filePaths.size === 0) {
      return results;
    }

    try {
      // Get all items in the library with their file paths
      // Using a larger page size to minimize API calls
      let offset = 0;
      const pageSize = 500;
      let totalSize = 0;

      do {
        const response = await this.plexClient.query<{
          MediaContainer: {
            totalSize: number;
            Metadata?: {
              ratingKey: string;
              Media?: {
                Part?: {
                  file: string;
                }[];
              }[];
            }[];
          };
        }>({
          uri: `/library/sections/${libraryId}/all?includeGuids=1${
            type ? `&type=${type}` : ''
          }`,
          extraHeaders: {
            'X-Plex-Container-Start': `${offset}`,
            'X-Plex-Container-Size': `${pageSize}`,
          },
        });

        totalSize = response.MediaContainer.totalSize;
        const items = response.MediaContainer.Metadata ?? [];

        for (const item of items) {
          if (!item.Media) continue;

          for (const media of item.Media) {
            if (!media.Part) continue;

            for (const part of media.Part) {
              // Use exact path match to avoid deleting wrong items
              if (part.file && filePaths.has(part.file)) {
                const existing = results.get(part.file) || [];
                // Avoid duplicate rating keys for same path
                if (!existing.includes(item.ratingKey)) {
                  existing.push(item.ratingKey);
                  results.set(part.file, existing);
                }
              }
            }
          }
        }

        offset += pageSize;
      } while (offset < totalSize);

      return results;
    } catch (error) {
      logger.error('Failed to find Plex items by file paths', {
        label: 'Plex API',
        libraryId,
        pathCount: filePaths.size,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error; // Re-throw so caller can handle appropriately
    }
  }

  // PLEX.TV METHODS - Delegated to PlexTvAPI

  /**
   * Get Plex user display name for a given Plex user ID
   * Delegates to PlexTvAPI
   */
  public async getPlexUserTitle(userPlexId: string): Promise<string | null> {
    if (!this.plexToken) {
      return null;
    }
    const PlexTvAPI = (await import('./plextv')).default;
    const plexTvApi = new PlexTvAPI(this.plexToken);
    return plexTvApi.getPlexUserTitle(userPlexId);
  }

  // HUB MANAGEMENT METHODS - Delegated to PlexHubManager

  /**
   * Get all hubs for a specific library section
   * Returns both built-in hubs (Recently Added, etc.) and custom collections
   */
  public async getLibraryHubs(sectionId: string): Promise<unknown> {
    return this.hubManager.getLibraryHubs(sectionId);
  }

  public clearHubManagementCache(): void {
    this.hubManager.clearHubManagementCache();
  }

  /**
   * Get hub management interface for a library section
   * This endpoint provides the drag-and-drop hub ordering interface
   */
  public async getHubManagement(
    sectionId: string
  ): Promise<PlexHubManagementResponse> {
    return this.hubManager.getHubManagement(sectionId);
  }

  /**
   * Move a hub to a new position in the library home screen
   */
  public async moveHub(
    sectionId: string,
    hubId: string,
    afterHubId?: string
  ): Promise<void> {
    return this.hubManager.moveHub(sectionId, hubId, afterHubId);
  }

  /**
   * Get current collection visibility settings
   */
  public async getCollectionVisibility(
    collectionRatingKey: string
  ): Promise<unknown> {
    return this.hubManager.getCollectionVisibility(collectionRatingKey);
  }

  /**
   * Update hub visibility settings
   */
  public async updateHubVisibility(
    sectionId: string,
    hubId: string,
    visibility: {
      promotedToRecommended?: boolean;
      promotedToOwnHome?: boolean;
      promotedToSharedHome?: boolean;
    }
  ): Promise<void> {
    return this.hubManager.updateHubVisibility(sectionId, hubId, visibility);
  }

  /**
   * Get all available hubs across all library sections
   */
  public async getAllLibraryHubs(): Promise<{ [sectionId: string]: unknown }> {
    return this.hubManager.getAllLibraryHubs();
  }

  /**
   * Reorder multiple hubs in a library section
   */
  public async reorderHubs(
    sectionId: string,
    desiredOrder: string[],
    positionedItemsCount?: number,
    libraryType?: 'movie' | 'show',
    syncCounter?: number
  ): Promise<boolean> {
    return this.hubManager.reorderHubs(
      sectionId,
      desiredOrder,
      positionedItemsCount,
      libraryType,
      syncCounter
    );
  }

  /**
   * Reset all hub management for a library section
   */
  public async resetLibraryHubManagement(sectionId: string): Promise<void> {
    return this.hubManager.resetLibraryHubManagement(sectionId);
  }

  /**
   * Delete a hub item from a library section
   */
  public async deleteHubItem(sectionId: string, hubId: string): Promise<void> {
    return this.hubManager.deleteHubItem(sectionId, hubId);
  }

  /**
   * Promote a collection to hub management
   */
  public async promoteCollectionToHub(
    collectionRatingKey: string,
    libraryId: string
  ): Promise<void> {
    return this.hubManager.promoteCollectionToHub(
      collectionRatingKey,
      libraryId
    );
  }

  // SMART COLLECTION METHODS - Delegated to PlexSmartCollectionManager

  /**
   * Create a label-based smart collection for unwatched items
   * New approach: labels items directly, no base collection needed
   */
  public async createLabelBasedSmartCollection(
    title: string,
    libraryKey: string,
    labelName: string,
    mediaType: 'movie' | 'tv' = 'movie',
    sortOption?: string,
    agregarrLabel?: string,
    maxItems?: number
  ): Promise<string | null> {
    return this.smartCollectionManager.createLabelBasedSmartCollection(
      title,
      libraryKey,
      labelName,
      mediaType,
      sortOption,
      agregarrLabel,
      maxItems
    );
  }

  /**
   * Set collection filtering to be based on the current user viewing the content
   */
  public async setCollectionUserFilter(
    collectionRatingKey: string
  ): Promise<void> {
    return this.smartCollectionManager.setCollectionUserFilter(
      collectionRatingKey
    );
  }

  /**
   * Update a label-based smart collection's URI (including sort parameters)
   */
  public async updateLabelBasedSmartCollectionUri(
    smartCollectionRatingKey: string,
    libraryKey: string,
    labelName: string,
    mediaType: 'movie' | 'tv' = 'movie',
    sortOption?: string,
    maxItems?: number
  ): Promise<void> {
    return this.smartCollectionManager.updateLabelBasedSmartCollectionUri(
      smartCollectionRatingKey,
      libraryKey,
      labelName,
      mediaType,
      sortOption,
      maxItems
    );
  }

  /**
   * Update an existing filtered hub smart collection's URI
   */
  public async updateFilteredHubUri(
    smartCollectionRatingKey: string,
    libraryKey: string,
    mediaType: 'movie' | 'tv',
    subtype:
      | 'recently_added'
      | 'recently_released'
      | 'recently_released_episodes'
      | 'recently_added_episodes',
    maxItems?: number,
    excludeCollectionTitles?: string[]
  ): Promise<void> {
    return this.smartCollectionManager.updateFilteredHubUri(
      smartCollectionRatingKey,
      libraryKey,
      mediaType,
      subtype,
      maxItems,
      excludeCollectionTitles
    );
  }

  /**
   * Delete a smart collection
   */
  public async deleteSmartCollection(
    smartCollectionRatingKey: string
  ): Promise<void> {
    return this.smartCollectionManager.deleteSmartCollection(
      smartCollectionRatingKey
    );
  }

  /**
   * Create a smart collection filtered by director name
   */
  public async createDirectorCollection(
    title: string,
    libraryKey: string,
    mediaType: 'movie' | 'tv',
    directorName: string,
    limit?: number
  ): Promise<string | null> {
    return this.smartCollectionManager.createDirectorCollection(
      title,
      libraryKey,
      mediaType,
      directorName,
      limit
    );
  }

  /**
   * Create a smart collection filtered by actor name
   */
  public async createActorCollection(
    title: string,
    libraryKey: string,
    mediaType: 'movie' | 'tv',
    actorName: string,
    limit?: number
  ): Promise<string | null> {
    return this.smartCollectionManager.createActorCollection(
      title,
      libraryKey,
      mediaType,
      actorName,
      limit
    );
  }

  /**
   * Create a smart collection filtered by attribute (genre, decade, resolution, contentRating)
   */
  public async createAttributeCollection(
    title: string,
    libraryKey: string,
    mediaType: 'movie' | 'tv',
    attribute: string,
    value: string,
    labelFilter: string
  ): Promise<string | null> {
    return this.smartCollectionManager.createAttributeCollection(
      title,
      libraryKey,
      mediaType,
      attribute,
      value,
      labelFilter
    );
  }

  /**
   * Update an existing attribute-based smart collection's URI
   */
  public async updateAttributeSmartCollectionUri(
    ratingKey: string,
    libraryKey: string,
    mediaType: 'movie' | 'tv',
    attribute: string,
    value: string,
    labelFilter: string
  ): Promise<void> {
    return this.smartCollectionManager.updateAttributeSmartCollectionUri(
      ratingKey,
      libraryKey,
      mediaType,
      attribute,
      value,
      labelFilter
    );
  }

  // POSTER MANAGEMENT METHODS - Delegated to PlexPosterManager

  /**
   * Get all available posters for a Plex item
   */
  public async getAvailablePosters(ratingKey: string): Promise<unknown[]> {
    return this.posterManager.getAvailablePosters(ratingKey);
  }

  /**
   * Upload a poster from a URL
   */
  public async uploadPosterFromUrl(
    ratingKey: string,
    url: string
  ): Promise<void> {
    return this.posterManager.uploadPosterFromUrl(ratingKey, url);
  }

  /**
   * Upload a poster from a local file path
   */
  public async uploadPosterFromFile(
    ratingKey: string,
    filepath: string
  ): Promise<void> {
    return this.posterManager.uploadPosterFromFile(ratingKey, filepath);
  }

  /**
   * Select an existing poster for an item
   */
  public async selectPoster(
    ratingKey: string,
    posterRatingKey: string
  ): Promise<void> {
    return this.posterManager.selectPoster(ratingKey, posterRatingKey);
  }

  /**
   * Lock the poster for an item (prevents auto-updates)
   */
  public async lockPoster(ratingKey: string): Promise<void> {
    return this.posterManager.lockPoster(ratingKey);
  }

  /**
   * Unlock the poster for an item (allows auto-updates)
   */
  public async unlockPoster(ratingKey: string): Promise<void> {
    return this.posterManager.unlockPoster(ratingKey);
  }

  /**
   * Get current poster URL for a Plex item
   */
  public async getCurrentPosterUrl(ratingKey: string): Promise<string | null> {
    return this.posterManager.getCurrentPosterUrl(ratingKey);
  }

  /**
   * Resolve the preferred Plex base-poster reference, favoring selected
   * uploaded posters such as those applied by Posterizarr.
   */
  public async getPreferredBasePosterUrl(
    ratingKey: string
  ): Promise<string | null> {
    return this.posterManager.getPreferredBasePosterUrl(ratingKey);
  }

  /**
   * Build a token-authenticated absolute URL for a Plex image path
   */
  public getAuthenticatedImageUrl(
    imagePath: string | undefined
  ): string | null {
    return this.posterManager.getAuthenticatedImageUrl(imagePath);
  }

  /**
   * Get current art/wallpaper URL for a Plex item
   */
  public async getCurrentArtUrl(ratingKey: string): Promise<string | null> {
    return this.posterManager.getCurrentArtUrl(ratingKey);
  }

  /**
   * Get current theme URL for a Plex item
   */
  public async getCurrentThemeUrl(ratingKey: string): Promise<string | null> {
    return this.posterManager.getCurrentThemeUrl(ratingKey);
  }

  /**
   * Combined method for uploading and setting a poster (backwards compatibility)
   */
  public async updateCollectionPoster(
    collectionRatingKey: string,
    posterPath: string
  ): Promise<void> {
    return this.posterManager.updateCollectionPoster(
      collectionRatingKey,
      posterPath
    );
  }

  /**
   * Upload wallpaper/art from a local file path
   */
  public async uploadArtFromFile(
    ratingKey: string,
    filepath: string
  ): Promise<void> {
    return this.posterManager.uploadArtFromFile(ratingKey, filepath);
  }

  /**
   * Lock the art for an item (prevents auto-updates)
   */
  public async lockArt(ratingKey: string): Promise<void> {
    return this.posterManager.lockArt(ratingKey);
  }

  /**
   * Upload theme music from a local file path
   */
  public async uploadThemeFromFile(
    ratingKey: string,
    filepath: string
  ): Promise<void> {
    return this.posterManager.uploadThemeFromFile(ratingKey, filepath);
  }

  /**
   * Lock the theme for an item (prevents auto-updates)
   */
  public async lockTheme(ratingKey: string): Promise<void> {
    return this.posterManager.lockTheme(ratingKey);
  }

  /**
   * Update collection summary/description
   */
  public async updateSummary(
    ratingKey: string,
    summary: string
  ): Promise<void> {
    return this.posterManager.updateSummary(ratingKey, summary);
  }

  /**
   * Get top directors from a library section with their item counts
   * Excludes placeholder items using the same query filters as smart collections
   */
  public async getLibraryDirectors(
    libraryId: string,
    limit?: number
  ): Promise<{ name: string; count: number }[]> {
    try {
      logger.debug(`Fetching directors from library ${libraryId}`, {
        label: 'Plex API',
        libraryId,
        limit,
      });

      // Fetch library metadata to determine media type
      const libraries = await this.getLibraries();
      const library = libraries.find((lib) => lib.key === libraryId);
      const mediaType = library?.type === 'show' ? 'tv' : 'movie';
      const type = mediaType === 'movie' ? 1 : 2;

      // Build query with placeholder exclusions via label (same as smart collections)
      const labelFilter = encodeURIComponent('trailer-placeholder');
      const queryUri = `/library/sections/${libraryId}/all?type=${type}&label!=${labelFilter}`;

      const response = await this.plexClient.query<{
        MediaContainer: {
          totalSize: number;
          Metadata?: {
            Director?: { tag: string }[];
          }[];
        };
      }>({
        uri: queryUri,
        extraHeaders: {
          'X-Plex-Container-Size': '0', // Get all items
        },
      });

      const items = response.MediaContainer.Metadata || [];
      const directorCounts = new Map<string, number>();

      for (const item of items) {
        if (item.Director && Array.isArray(item.Director)) {
          for (const director of item.Director) {
            if (director.tag) {
              const currentCount = directorCounts.get(director.tag) || 0;
              directorCounts.set(director.tag, currentCount + 1);
            }
          }
        }
      }

      let directors = Array.from(directorCounts.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

      if (limit && limit > 0) {
        directors = directors.slice(0, limit);
      }

      logger.info(
        `Found ${directorCounts.size} unique directors in library ${libraryId}`,
        {
          label: 'Plex API',
          libraryId,
          totalDirectors: directorCounts.size,
          returned: directors.length,
          topDirectors: directors
            .slice(0, 5)
            .map((d) => `${d.name} (${d.count})`),
        }
      );

      return directors;
    } catch (error) {
      logger.error(`Failed to fetch directors from library ${libraryId}`, {
        label: 'Plex API',
        libraryId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get top actors from a library section with their item counts
   * Excludes placeholder items using the same query filters as smart collections
   */
  public async getLibraryActors(
    libraryId: string,
    limit?: number
  ): Promise<{ name: string; count: number }[]> {
    try {
      logger.debug(`Fetching actors from library ${libraryId}`, {
        label: 'Plex API',
        libraryId,
        limit,
      });

      // Fetch library metadata to determine media type
      const libraries = await this.getLibraries();
      const library = libraries.find((lib) => lib.key === libraryId);
      const mediaType = library?.type === 'show' ? 'tv' : 'movie';
      const type = mediaType === 'movie' ? 1 : 2;

      // Build query with placeholder exclusions via label (same as smart collections)
      const labelFilter = encodeURIComponent('trailer-placeholder');
      const queryUri = `/library/sections/${libraryId}/all?type=${type}&label!=${labelFilter}`;

      const response = await this.plexClient.query<{
        MediaContainer: {
          totalSize: number;
          Metadata?: {
            Role?: { tag: string }[];
          }[];
        };
      }>({
        uri: queryUri,
        extraHeaders: {
          'X-Plex-Container-Size': '0', // Get all items
        },
      });

      const items = response.MediaContainer.Metadata || [];
      const actorCounts = new Map<string, number>();

      for (const item of items) {
        const roles = (item as { Role?: { tag?: string }[] }).Role;
        if (roles && Array.isArray(roles)) {
          for (const role of roles) {
            if (role.tag) {
              const currentCount = actorCounts.get(role.tag) || 0;
              actorCounts.set(role.tag, currentCount + 1);
            }
          }
        }
      }

      let actors = Array.from(actorCounts.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

      if (limit && limit > 0) {
        actors = actors.slice(0, limit);
      }

      logger.info(
        `Found ${actorCounts.size} unique actors in library ${libraryId}`,
        {
          label: 'Plex API',
          libraryId,
          totalActors: actorCounts.size,
          returned: actors.length,
          topActors: actors.slice(0, 5).map((d) => `${d.name} (${d.count})`),
        }
      );

      return actors;
    } catch (error) {
      logger.error(`Failed to fetch actors from library ${libraryId}`, {
        label: 'Plex API',
        libraryId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get library items for a specific director (movies or TV)
   */
  public async getItemsByDirector(
    libraryId: string,
    directorName: string,
    mediaType: 'movie' | 'tv',
    limit?: number
  ): Promise<PlexLibraryItem[]> {
    const type = mediaType === 'movie' ? 1 : 2;
    const directorFilter = encodeURIComponent(directorName);
    const labelFilter = encodeURIComponent('trailer-placeholder');

    let uri = `/library/sections/${libraryId}/all?type=${type}&director=${directorFilter}&label!=${labelFilter}&includeGuids=1`;
    if (limit && limit > 0) {
      uri += `&limit=${limit}`;
    }

    try {
      const response = await this.plexClient.query<{
        MediaContainer: { Metadata?: PlexLibraryItem[] };
      }>({
        uri,
        extraHeaders: limit
          ? {
              'X-Plex-Container-Size': `${limit}`,
            }
          : undefined,
      });

      return response.MediaContainer.Metadata || [];
    } catch (error) {
      logger.error(
        `Failed to fetch items for director "${directorName}" in library ${libraryId}`,
        {
          label: 'Plex API',
          directorName,
          libraryId,
          mediaType,
          limit,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      throw error;
    }
  }

  /**
   * Get library items for a specific actor (movies or TV)
   */
  public async getItemsByActor(
    libraryId: string,
    actorName: string,
    mediaType: 'movie' | 'tv',
    limit?: number
  ): Promise<PlexLibraryItem[]> {
    const type = mediaType === 'movie' ? 1 : 2;
    const actorFilter = encodeURIComponent(actorName);
    const labelFilter = encodeURIComponent('trailer-placeholder');

    let uri = `/library/sections/${libraryId}/all?type=${type}&actor=${actorFilter}&label!=${labelFilter}&includeGuids=1`;
    if (limit && limit > 0) {
      uri += `&limit=${limit}`;
    }

    try {
      const response = await this.plexClient.query<{
        MediaContainer: { Metadata?: PlexLibraryItem[] };
      }>({
        uri,
        extraHeaders: limit
          ? {
              'X-Plex-Container-Size': `${limit}`,
            }
          : undefined,
      });

      return response.MediaContainer.Metadata || [];
    } catch (error) {
      logger.error(
        `Failed to fetch items for actor "${actorName}" in library ${libraryId}`,
        {
          label: 'Plex API',
          actorName,
          libraryId,
          mediaType,
          limit,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      throw error;
    }
  }

  /**
   * Get all library items that carry a specific label (movies or TV).
   * Pages through the full result set so the entire labelled subset is returned.
   */
  public async getItemsByLabel(
    libraryId: string,
    label: string,
    mediaType: 'movie' | 'tv'
  ): Promise<PlexLibraryItem[]> {
    const type = mediaType === 'movie' ? 1 : 2;
    const labelFilter = encodeURIComponent(label);
    // Exclude Agregarr's own placeholder items so they never leak into a label collection.
    const placeholderFilter = encodeURIComponent('trailer-placeholder');
    const pageSize = 200;
    const items: PlexLibraryItem[] = [];

    try {
      for (let offset = 0; ; offset += pageSize) {
        const response = await this.plexClient.query<{
          MediaContainer: {
            totalSize?: number;
            size?: number;
            Metadata?: PlexLibraryItem[];
          };
        }>({
          uri: `/library/sections/${libraryId}/all?type=${type}&label=${labelFilter}&label!=${placeholderFilter}&includeGuids=1`,
          extraHeaders: {
            'X-Plex-Container-Start': `${offset}`,
            'X-Plex-Container-Size': `${pageSize}`,
          },
        });

        const batch = response.MediaContainer.Metadata || [];
        items.push(...batch);

        const total = response.MediaContainer.totalSize ?? 0;
        if (batch.length < pageSize || items.length >= total) {
          break;
        }
      }

      logger.debug(
        `Found ${items.length} items with label "${label}" in library ${libraryId}`,
        { label: 'Plex API', plexLabel: label, libraryId, mediaType }
      );

      return items;
    } catch (error) {
      logger.error(
        `Failed to fetch items for label "${label}" in library ${libraryId}`,
        {
          label: 'Plex API',
          plexLabel: label,
          libraryId,
          mediaType,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      throw error;
    }
  }

  /**
   * Get all labels for a library
   * @param libraryId - Library section key
   * @returns Array of unique label names
   */
  /**
   * Mark a Plex item as unplayed (reset watched status)
   * Uses Plex's /:/unscrobble endpoint
   */
  public async markItemAsUnplayed(ratingKey: string): Promise<void> {
    try {
      await this.plexClient.query(
        `/:/unscrobble?key=${ratingKey}&identifier=com.plexapp.plugins.library`
      );
      logger.debug('Marked item as unplayed', {
        label: 'Plex API',
        ratingKey,
      });
    } catch (error) {
      logger.error('Failed to mark item as unplayed', {
        label: 'Plex API',
        ratingKey,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get all values for a library attribute (genre, decade, resolution, contentRating)
   * @param libraryId - Library section key
   * @param attribute - Attribute type to query
   * @param mediaType - Plex type filter (1=movie, 2=show); derived from the library if omitted
   */
  public async getLibraryAttributes(
    libraryId: string,
    attribute: 'genre' | 'decade' | 'resolution' | 'contentRating',
    mediaType?: number
  ): Promise<{ key: string; title: string; fastKey: string }[]> {
    let type = mediaType;

    if (type === undefined) {
      const libraries = await this.getLibraries();
      const library = libraries.find((lib) => lib.key === libraryId);

      if (!library) {
        throw new Error(`Library ${libraryId} not found`);
      }

      type = library.type === 'show' ? 2 : 1;
    }

    const response = await this.plexClient.query<{
      MediaContainer: {
        Directory?: {
          key: string;
          title: string;
          fastKey: string;
          type: string;
        }[];
      };
    }>(`/library/sections/${libraryId}/${attribute}?type=${type}`);

    const values = (response.MediaContainer?.Directory || []).map((d) => ({
      key: d.key,
      title: d.title,
      fastKey: d.fastKey,
    }));

    logger.debug(
      `Found ${values.length} ${attribute} values in library ${libraryId}`,
      {
        label: 'Plex API',
        libraryId,
        attribute,
        valueCount: values.length,
      }
    );

    return values;
  }

  public async getLibraryLabels(libraryId: string): Promise<string[]> {
    try {
      // Fetch library metadata to determine media type
      const libraries = await this.getLibraries();
      const library = libraries.find((lib) => lib.key === libraryId);

      if (!library) {
        logger.warn(`Library ${libraryId} not found`, {
          label: 'Plex API',
        });
        return [];
      }

      // Type parameter: 1=movie, 2=show
      const type = library.type === 'show' ? 2 : 1;

      const response = await this.plexClient.query<{
        MediaContainer: {
          Directory?: { key: string; title: string }[];
        };
      }>(`/library/sections/${libraryId}/label?type=${type}`);

      const directories = response.MediaContainer?.Directory || [];
      const labels = directories
        .map((d) => d.title)
        .filter(
          (title): title is string => !!title && title !== 'trailer-placeholder'
        );

      logger.debug(`Found ${labels.length} labels in library ${libraryId}`, {
        label: 'Plex API',
        libraryId,
        labelCount: labels.length,
      });

      return labels;
    } catch (error) {
      logger.error(`Failed to fetch labels from library ${libraryId}`, {
        label: 'Plex API',
        libraryId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}

export default PlexAPI;

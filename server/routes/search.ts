import type { PlexLibraryItem } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import axios from 'axios';
import { Router } from 'express';

const searchRouter = Router();

/**
 * Proxy Plex images to avoid CORS/mixed-content issues
 * GET /api/v1/plex/image?path=/library/metadata/123/thumb/456
 */
searchRouter.get('/image', async (req, res) => {
  try {
    const imagePath = req.query.path as string;

    if (!imagePath) {
      return res.status(400).json({ error: 'Image path is required' });
    }

    // Get admin user for Plex API access
    const { getAdminUser } = await import(
      '@server/lib/collections/core/CollectionUtilities'
    );
    const admin = await getAdminUser();

    if (!admin) {
      return res.status(500).json({ error: 'No admin user found' });
    }

    // Get Plex settings
    const settings = getSettings();
    const plexSettings = settings.plex;
    const protocol = plexSettings.useSsl ? 'https' : 'http';
    const plexBaseUrl = `${protocol}://${plexSettings.ip}:${plexSettings.port}`;

    // Fetch the image from Plex
    const imageUrl = `${plexBaseUrl}${imagePath}?X-Plex-Token=${admin.plexToken}`;

    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
    });

    // Set appropriate headers
    const contentType = response.headers['content-type'] || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day

    return res.send(Buffer.from(response.data));
  } catch (error) {
    logger.error('Failed to proxy Plex image', {
      label: 'PlexImageProxy',
      error: error instanceof Error ? error.message : String(error),
    });

    return res.status(500).json({ error: 'Failed to fetch image from Plex' });
  }
});

interface PlexSearchResult {
  ratingKey: string;
  title: string;
  year?: number;
  type: 'movie' | 'show';
  thumb?: string;
  libraryId: string;
  libraryName: string;
}

/**
 * Search across all Plex libraries
 * GET /api/v1/plex/search?query=...&limit=20
 */
searchRouter.get('/search', async (req, res) => {
  try {
    const query = req.query.query as string;
    const limit = parseInt((req.query.limit as string) || '20', 10);

    if (!query || query.trim().length === 0) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    // Get admin user for Plex API access
    const { getAdminUser } = await import(
      '@server/lib/collections/core/CollectionUtilities'
    );
    const admin = await getAdminUser();

    if (!admin) {
      return res.status(500).json({ error: 'No admin user found' });
    }

    const plexApi = new PlexAPI({ plexToken: admin.plexToken });

    // Perform search using Plex's global search
    // Note: /hubs/search returns results grouped in "Hub" objects, each containing Metadata
    const searchResults = await plexApi['plexClient'].query<{
      MediaContainer?: {
        Hub?: {
          Metadata?: PlexLibraryItem[];
        }[];
      };
    }>(`/hubs/search?query=${encodeURIComponent(query)}&limit=${limit * 2}`);

    logger.debug('Plex search raw response', {
      label: 'PlexSearch',
      query,
      hasMediaContainer: !!searchResults.MediaContainer,
      hubCount: searchResults.MediaContainer?.Hub?.length || 0,
    });

    // Extract all metadata from all hubs
    const rawResults: PlexLibraryItem[] = [];
    if (searchResults.MediaContainer?.Hub) {
      for (const hub of searchResults.MediaContainer.Hub) {
        if (hub.Metadata) {
          // Filter out results with a "reason" field - these are related matches, not direct title matches
          // Direct matches won't have a reason field
          const directMatches = hub.Metadata.filter(
            (item) => !(item as { reason?: string }).reason
          );
          rawResults.push(...directMatches);
        }
      }
    }

    // Filter to only movies and shows, and extract library information
    const filteredResults: PlexSearchResult[] = [];

    for (const item of rawResults) {
      // Only include movies and shows (exclude episodes, seasons, artists, etc.)
      if (item.type !== 'movie' && item.type !== 'show') {
        continue;
      }

      // Get library information
      const libraryId =
        (item as { librarySectionID?: string }).librarySectionID?.toString() ||
        '';
      let libraryName =
        (item as { librarySectionTitle?: string }).librarySectionTitle ||
        'Unknown Library';

      // Try to get library name from section if not available
      if (
        !(item as { librarySectionTitle?: string }).librarySectionTitle &&
        libraryId
      ) {
        try {
          const libraries = await plexApi.getLibraries();
          const library = libraries.find((lib) => lib.key === libraryId);
          libraryName = library?.title || 'Unknown Library';
        } catch (error) {
          logger.debug('Failed to fetch library name', {
            label: 'PlexSearch',
            libraryId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Construct proxy URL for thumb if available
      const thumbPath = (item as { thumb?: string }).thumb;
      const proxyThumbUrl = thumbPath
        ? `/api/v1/plex/image?path=${encodeURIComponent(thumbPath)}`
        : undefined;

      filteredResults.push({
        ratingKey: item.ratingKey,
        title: item.title,
        year: item.year,
        type: item.type as 'movie' | 'show',
        thumb: proxyThumbUrl,
        libraryId,
        libraryName,
      });

      // Stop if we have enough results
      if (filteredResults.length >= limit) {
        break;
      }
    }

    logger.info('Plex search completed', {
      label: 'PlexSearch',
      query,
      totalResults: rawResults.length,
      filteredResults: filteredResults.length,
    });

    return res.status(200).json({
      results: filteredResults,
      totalResults: filteredResults.length,
    });
  } catch (error) {
    logger.error('Failed to search Plex', {
      label: 'PlexSearch',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return res.status(500).json({
      error: 'Failed to search Plex',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * Get all unique labels across all movie/show libraries
 * GET /api/v1/plex/labels
 * Returns: { labels: string[] }
 */
searchRouter.get('/labels', async (_req, res) => {
  try {
    // Get admin user for Plex API access
    const { getAdminUser } = await import(
      '@server/lib/collections/core/CollectionUtilities'
    );
    const admin = await getAdminUser();

    if (!admin) {
      return res.status(500).json({ error: 'No admin user found' });
    }

    const plexApi = new PlexAPI({ plexToken: admin.plexToken });

    // Get all libraries
    const allLibraries = await plexApi.getLibraries();

    // Filter to only movie and show libraries
    const libraries = allLibraries.filter(
      (lib) => lib.type === 'movie' || lib.type === 'show'
    );

    // Fetch labels for each library and collect unique ones
    const allLabels = new Set<string>();

    for (const library of libraries) {
      const labels = await plexApi.getLibraryLabels(library.key);
      for (const label of labels) {
        allLabels.add(label);
      }
    }

    // Sort alphabetically
    const sortedLabels = Array.from(allLabels).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );

    logger.debug('Fetched unique labels from all libraries', {
      label: 'PlexLabels',
      libraryCount: libraries.length,
      uniqueLabels: sortedLabels.length,
    });

    return res.status(200).json({ labels: sortedLabels });
  } catch (error) {
    logger.error('Failed to fetch Plex labels', {
      label: 'PlexLabels',
      error: error instanceof Error ? error.message : String(error),
    });

    return res.status(500).json({
      error: 'Failed to fetch Plex labels',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

const ATTRIBUTE_TYPES = [
  'genre',
  'decade',
  'resolution',
  'contentRating',
] as const;
type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

/**
 * Discover attribute values (genre/decade/resolution/contentRating) for a library,
 * with rendered-name conflict detection against existing collections
 * GET /api/v1/plex/library/:libraryId/attributes/:attributeType?template=...&configId=...
 */
searchRouter.get(
  '/library/:libraryId/attributes/:attributeType',
  async (req, res) => {
    const { libraryId, attributeType } = req.params;
    const template = req.query.template as string | undefined;
    const configId = req.query.configId as string | undefined;

    logger.debug('Library attribute discovery requested', {
      label: 'PlexLibraryAttributes',
      libraryId,
      attributeType,
      hasTemplate: !!template,
      configId,
    });

    if (!(ATTRIBUTE_TYPES as readonly string[]).includes(attributeType)) {
      return res.status(400).json({
        error: `Invalid attribute type. Must be one of: ${ATTRIBUTE_TYPES.join(
          ', '
        )}`,
      });
    }

    try {
      // Get admin user for Plex API access
      const { getAdminUser } = await import(
        '@server/lib/collections/core/CollectionUtilities'
      );
      const admin = await getAdminUser();

      if (!admin) {
        return res.status(500).json({ error: 'No admin user found' });
      }

      const plexApi = new PlexAPI({ plexToken: admin.plexToken });

      const libraries = await plexApi.getLibraries();
      const library = libraries.find((lib) => lib.key === libraryId);

      if (!library || (library.type !== 'movie' && library.type !== 'show')) {
        return res
          .status(400)
          .json({ error: `Library ${libraryId} not found` });
      }

      let values: { key: string; title: string; fastKey: string }[];
      try {
        values = await plexApi.getLibraryAttributes(
          libraryId,
          attributeType as AttributeType,
          library.type === 'show' ? 2 : 1
        );
      } catch (error) {
        logger.error('Failed to fetch library attributes', {
          label: 'PlexLibraryAttributes',
          libraryId,
          attributeType,
          error: error instanceof Error ? error.message : String(error),
        });
        return res.status(500).json({
          error: 'Failed to fetch library attributes',
          message: error instanceof Error ? error.message : String(error),
        });
      }

      const allCollections = await plexApi.getAllCollections();
      const libraryCollections = allCollections.filter(
        (collection) => collection.libraryKey === libraryId
      );

      const essentialsPrefix = configId
        ? `agregarressentials-${configId}-`.toLowerCase()
        : undefined;

      const relevantCollections = essentialsPrefix
        ? libraryCollections.filter((collection) => {
            const labels = Array.isArray(collection.labels)
              ? collection.labels
              : [];
            const labelTexts = labels.map((l: string | { tag: string }) =>
              typeof l === 'string' ? l : l.tag
            );
            return !labelTexts.some((labelText) =>
              labelText.toLowerCase().startsWith(essentialsPrefix)
            );
          })
        : libraryCollections;

      const conflicts: { title: string; ratingKey: string }[] = [];

      for (const value of values) {
        const renderedTitle = template
          ? template.replace('{value}', value.title)
          : value.title;

        const conflict = relevantCollections.find(
          (collection) =>
            collection.title.toLowerCase() === renderedTitle.toLowerCase()
        );

        if (conflict) {
          conflicts.push({
            title: conflict.title,
            ratingKey: conflict.ratingKey,
          });
        }
      }

      return res.status(200).json({ values, conflicts });
    } catch (error) {
      logger.error('Failed to discover library attributes', {
        label: 'PlexLibraryAttributes',
        libraryId,
        attributeType,
        error: error instanceof Error ? error.message : String(error),
      });

      return res.status(500).json({
        error: 'Failed to discover library attributes',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

export default searchRouter;

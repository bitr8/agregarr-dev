import type { TraktListResponse } from '@server/api/trakt';
import type { LibraryItemsCache } from '@server/lib/collections/core/CollectionUtilities';
import logger from '@server/logger';
import {
  buildTraktRedirectUri,
  persistTraktTokens,
} from '@server/utils/traktAuth';
import fs from 'fs';
import path from 'path';

/**
 * RandomListManager - Manages random list configuration files with built-in defaults
 *
 * Handles reading and parsing of config files for random list rotation:
 * - /config/random-lists/trakt.txt
 * - /config/random-lists/tmdb.txt
 * - /config/random-lists/imdb.txt
 * - /config/random-lists/letterboxd.txt
 *
 * Also provides built-in default lists when user configuration is not available.
 */
export class RandomListManager {
  private static configDir: string;
  private static cache: Map<
    string,
    { enabled: boolean; urls: string[]; lastRead: number }
  > = new Map();
  private static readonly CACHE_TTL = 60000; // 1 minute cache

  // Discovery cache for dynamically discovered lists
  private static discoveryCache: Map<
    string,
    {
      urls: string[];
      lastDiscovered: number;
      nextRefresh: number;
      failureCount?: number;
    }
  > = new Map();
  private static readonly DISCOVERY_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
  private static readonly NEGATIVE_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours for failed discovery

  // Built-in fallback lists — stable editorial lists, used when discovery fails
  private static readonly FALLBACK_LISTS: Record<string, string[]> = {
    imdb: [
      'https://www.imdb.com/list/ls004285815/', // IMDb Top 250 Movies
      'https://www.imdb.com/list/ls058982944/', // Oscar Winning Movies
      'https://www.imdb.com/list/ls055592025/', // AFI's 100 Years...100 Movies
      'https://www.imdb.com/list/ls091520106/', // Sci-Fi Movies
      'https://www.imdb.com/list/ls056092300/', // Best Horror Movies
      'https://www.imdb.com/list/ls009668711/', // Best 80s Movies
      'https://www.imdb.com/list/ls068082370/', // Must See Crime Movies
    ],
    letterboxd: [
      'https://letterboxd.com/official/list/top-250-films-with-the-most-fans/',
      'https://letterboxd.com/official/list/the-letterboxd-top-250-as-of-2025/',
      'https://letterboxd.com/imthelizardking/list/rotten-tomatoes-300-best-movies-of-all-time/',
      'https://letterboxd.com/jbutts15/list/the-complete-criterion-collection/',
      'https://letterboxd.com/dave/list/imdb-top-250/',
    ],
    tmdb: [
      'https://www.themoviedb.org/collection/645', // James Bond (27)
      'https://www.themoviedb.org/collection/9485', // Fast & Furious (12)
      'https://www.themoviedb.org/collection/10', // Star Wars (9)
      'https://www.themoviedb.org/collection/1241', // Harry Potter (8)
      'https://www.themoviedb.org/collection/87359', // Mission: Impossible (8)
      'https://www.themoviedb.org/collection/328', // Jurassic Park (7)
      'https://www.themoviedb.org/collection/86311', // Avengers (6)
      'https://www.themoviedb.org/collection/8945', // Mad Max (6)
      'https://www.themoviedb.org/collection/399', // Predator (6)
      'https://www.themoviedb.org/collection/84', // Indiana Jones (5)
      'https://www.themoviedb.org/collection/1570', // Die Hard (5)
      'https://www.themoviedb.org/collection/295', // Pirates of the Caribbean (5)
      'https://www.themoviedb.org/collection/31562', // Bourne (5)
      'https://www.themoviedb.org/collection/404609', // John Wick (4)
      'https://www.themoviedb.org/collection/2344', // The Matrix (4)
      'https://www.themoviedb.org/collection/8091', // Alien (4)
    ],
  };

  // TMDB filtered collections cache (from daily export)
  private static tmdbFilteredCache: {
    collections: { id: number; name: string }[];
    lastFiltered: number;
    nextRefresh: number;
  } | null = null;
  private static readonly TMDB_FILTERED_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

  // TMDB collections discovered from user's library (much smaller, pre-validated)
  private static tmdbLibraryCollectionsCache: {
    urls: string[];
    lastBuilt: number;
    nextRefresh: number;
  } | null = null;
  private static tmdbLibraryBuildPromise: Promise<string[]> | null = null;
  private static readonly TMDB_LIBRARY_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
  private static readonly TMDB_LIBRARY_NEGATIVE_TTL = 4 * 60 * 60 * 1000; // 4 hours

  /**
   * Initialize the RandomListManager with the config directory
   */
  public static initialize(configDirectory: string): void {
    this.configDir = path.join(configDirectory, 'random-lists');

    // Ensure the random-lists directory exists
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
      logger.info('Created random-lists config directory', {
        label: 'RandomListManager',
        path: this.configDir,
      });
    }

    // Create template files if they don't exist
    this.createTemplateFiles();
  }

  /**
   * Create template configuration files for all source types
   */
  private static createTemplateFiles(): void {
    const templates = {
      trakt: `# Trakt Random Lists Configuration
#
# Add one Trakt list URL per line below to override the default true random search
# Set enabled=true and add custom URLs below to use your own lists instead

enabled=false

# Example URLs (set enabled=true to activate):

https://trakt.tv/users/justin/lists/imdb-top-250
https://trakt.tv/users/giladg/lists/netflix-originals
https://trakt.tv/users/sp1ti/lists/best-of-2023
https://trakt.tv/users/hdlists/lists/popular-tv-shows
https://trakt.tv/users/movistapp/lists/oscar-winners
`,
      tmdb: `# TMDB Random Collections Configuration
#
# Add one TMDB collection URL per line below to override the default true random search
# Set enabled=true and add custom URLs below to use your own collections instead

enabled=false

# Example URLs (set enabled=true to activate):

https://www.themoviedb.org/collection/1570
https://www.themoviedb.org/collection/448150
https://www.themoviedb.org/collection/9485
https://www.themoviedb.org/collection/86311
https://www.themoviedb.org/collection/131295
`,
      imdb: `# IMDb Random Lists Configuration
#
# Add one IMDb list URL per line below to override the default true random search
# Set enabled=true and add custom URLs below to use your own lists instead

enabled=false

# Example URLs (set enabled=true to activate):

https://www.imdb.com/list/ls004285815/
https://www.imdb.com/list/ls058982944/
https://www.imdb.com/list/ls055592025/
https://www.imdb.com/list/ls091520106/
https://www.imdb.com/list/ls056092300/
`,
      letterboxd: `# Letterboxd Random Lists Configuration
#
# Add one Letterboxd list URL per line below to override the default true random search
# Set enabled=true and add custom URLs below to use your own lists instead

enabled=false

# Example URLs (set enabled=true to activate):

https://letterboxd.com/official/list/top-250-films-with-the-most-fans/
https://letterboxd.com/official/list/the-letterboxd-top-250-as-of-2025/
https://letterboxd.com/imthelizardking/list/rotten-tomatoes-300-best-movies-of-all-time/
https://letterboxd.com/jbutts15/list/the-complete-criterion-collection/
https://letterboxd.com/dave/list/imdb-top-250/
`,
    };

    for (const [sourceType, template] of Object.entries(templates)) {
      const filePath = path.join(this.configDir, `${sourceType}.txt`);

      // Only create the file if it doesn't exist (don't overwrite user customizations)
      if (!fs.existsSync(filePath)) {
        try {
          fs.writeFileSync(filePath, template, 'utf-8');
          logger.debug(`Created template file: ${sourceType}.txt`, {
            label: 'RandomListManager',
            filePath,
          });
        } catch (error) {
          logger.warn(`Failed to create template file: ${sourceType}.txt`, {
            label: 'RandomListManager',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  /**
   * Check if random lists are enabled for a given source type
   */
  public static isEnabled(
    sourceType: 'trakt' | 'tmdb' | 'imdb' | 'letterboxd'
  ): boolean {
    const config = this.readConfig(sourceType);
    return config.enabled;
  }

  /**
   * Get random list URLs for a given source type
   * Priority: User config > Dynamically discovered lists
   */
  public static async getRandomUrls(
    sourceType: 'trakt' | 'tmdb' | 'imdb' | 'letterboxd',
    targetMediaType?: 'movie' | 'tv'
  ): Promise<string[]> {
    const config = this.readConfig(sourceType);

    // Priority 1: If user has configured URLs and enabled random lists, use those
    if (config.enabled && config.urls.length > 0) {
      logger.debug(`Using user-configured random lists for ${sourceType}`, {
        label: 'RandomListManager',
        sourceType,
        count: config.urls.length,
      });
      return config.urls;
    }

    // Priority 2: Dynamically discover lists
    const discoveredUrls = await this.getDiscoveredUrls(
      sourceType,
      targetMediaType
    );
    if (discoveredUrls.length > 0) {
      logger.info(
        `Using ${discoveredUrls.length} discovered random lists for ${sourceType}`,
        {
          label: 'RandomListManager',
          sourceType,
          count: discoveredUrls.length,
        }
      );
      return discoveredUrls;
    }

    // Priority 3: Built-in fallback lists (movie-only — TV has no curated fallbacks)
    if (targetMediaType !== 'tv') {
      const fallbackUrls = this.FALLBACK_LISTS[sourceType];
      if (fallbackUrls && fallbackUrls.length > 0) {
        logger.warn(
          `Discovery failed for ${sourceType}, using ${fallbackUrls.length} built-in fallback lists`,
          {
            label: 'RandomListManager',
            sourceType,
            count: fallbackUrls.length,
          }
        );
        return fallbackUrls;
      }
    }

    logger.warn(`No random lists available for ${sourceType}`, {
      label: 'RandomListManager',
      sourceType,
    });
    return [];
  }

  /**
   * Get a random URL with title for a given source type with optional media type validation
   */
  public static async getRandomUrlWithTitle(
    sourceType: 'trakt' | 'tmdb' | 'imdb' | 'letterboxd',
    maxItems: number,
    targetMediaType?: 'movie' | 'tv',
    libraryCache?: LibraryItemsCache
  ): Promise<{ url: string; title: string } | null> {
    const result = await this.getRandomUrl(
      sourceType,
      maxItems,
      targetMediaType,
      libraryCache
    );
    if (!result) {
      return null;
    }

    const title = await this.extractTitleFromUrl(result, sourceType);
    return { url: result, title };
  }

  /**
   * Extract title from a list URL using the same logic as the fetch-title endpoint
   */
  private static async extractTitleFromUrl(
    url: string,
    sourceType: 'trakt' | 'tmdb' | 'imdb' | 'letterboxd'
  ): Promise<string> {
    try {
      switch (sourceType) {
        case 'trakt': {
          const TraktAPI = (await import('@server/api/trakt')).default;
          const { getSettings } = await import('@server/lib/settings');
          const settings = getSettings();

          const traktClientId =
            settings.trakt.clientId || settings.trakt.apiKey;
          if (!traktClientId) {
            return 'Trakt List';
          }

          const traktClient = new TraktAPI({
            clientId: traktClientId,
            accessToken: settings.trakt.accessToken,
            clientSecret: settings.trakt.clientSecret,
            refreshToken: settings.trakt.refreshToken,
            tokenExpiresAt: settings.trakt.tokenExpiresAt,
            redirectUri: buildTraktRedirectUri(settings),
            onTokenRefreshed: (tokens) => persistTraktTokens(settings, tokens),
          });

          // Parse the URL to extract username and list slug (supports both trakt.tv and app.trakt.tv)
          const userListMatch = url.match(
            /(?:app\.)?trakt\.tv\/users\/([^/]+)\/lists\/([^/?]+)/
          );
          const officialListMatch = url.match(
            /(?:app\.)?trakt\.tv\/lists\/official\/([^/?]+)/
          );

          try {
            if (userListMatch) {
              const [, username, listSlug] = userListMatch;
              // Extract domain to preserve original URL format (trakt.tv or app.trakt.tv)
              const domain = url.includes('app.trakt.tv')
                ? 'app.trakt.tv'
                : 'trakt.tv';
              const listMetadata = await traktClient.getListMetadata(
                `https://${domain}/users/${username}/lists/${listSlug}`
              );
              return listMetadata.name || 'Trakt List';
            } else if (officialListMatch) {
              // For official lists, we might need different handling
              return 'Trakt Official List';
            }
          } catch (error) {
            // Fallback to slug conversion if API call fails
            const match = userListMatch || officialListMatch;
            if (match && match[2]) {
              return match[2]
                .replace(/-/g, ' ')
                .replace(/\b\w/g, (l: string) => l.toUpperCase());
            }
          }

          return 'Trakt List';
        }

        case 'tmdb': {
          const TheMovieDb = (await import('@server/api/themoviedb')).default;
          const tmdbClient = new TheMovieDb();

          const urlMatch = url.match(/themoviedb\.org\/collection\/(\d+)/);
          if (urlMatch) {
            const collectionId = parseInt(urlMatch[1]);
            const collection = await tmdbClient.getCollection({ collectionId });
            return collection.name;
          }
          return 'TMDB Collection';
        }

        case 'imdb': {
          const { ImdbAxiosClient } = await import(
            '@server/lib/collections/utils/ImdbAxiosClient'
          );
          const axiosInstance = await ImdbAxiosClient.getInstance();
          const response = await axiosInstance.get(url, { timeout: 15000 });

          // Extract title from HTML using the same logic as fetch-title endpoint
          const titleMatch = response.data.match(/<title>([^<]+)<\/title>/i);
          if (titleMatch) {
            let title = titleMatch[1].replace(' - IMDb', '').trim();

            // Decode HTML entities (same as Letterboxd)
            title = title
              .replace(/&lrm;/g, '') // Remove left-to-right mark
              .replace(/&rlm;/g, '') // Remove right-to-left mark
              .replace(/&bull;/g, '•') // Replace bullet entity with actual bullet
              .replace(/&ndash;/g, '–') // Replace en-dash
              .replace(/&mdash;/g, '—') // Replace em-dash
              .replace(/&hellip;/g, '…') // Replace ellipsis
              .replace(/&quot;/g, '"') // Replace quotes
              .replace(/&#0?39;/g, "'") // Replace apostrophe (with or without leading zero)
              .replace(/&#x27;/g, "'") // Replace hex-encoded apostrophe
              .replace(/&amp;/g, '&') // Replace ampersand (do this last)
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>');

            return title;
          }

          return 'IMDb List';
        }

        case 'letterboxd': {
          const { getSettings } = await import('@server/lib/settings');
          const usePlainHttpTitle =
            getSettings().main.letterboxdUsePlainHttp ?? false;
          let html: string;
          if (usePlainHttpTitle) {
            const { LetterboxdHttpClient } = await import(
              '@server/lib/collections/utils/LetterboxdHttpClient'
            );
            html = await LetterboxdHttpClient.fetchPage(url);
          } else {
            const { CloudflareSolver } = await import(
              '@server/lib/collections/utils/CloudflareSolver'
            );
            html = await CloudflareSolver.fetchPage(url);
          }

          // Extract title from HTML and clean it up using same logic as fetch-title endpoint
          const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
          if (titleMatch) {
            let rawTitle = titleMatch[1];

            // Decode HTML entities
            rawTitle = rawTitle
              .replace(/&lrm;/g, '') // Remove left-to-right mark
              .replace(/&rlm;/g, '') // Remove right-to-left mark
              .replace(/&bull;/g, '•') // Replace bullet entity with actual bullet
              .replace(/&ndash;/g, '–') // Replace en-dash
              .replace(/&mdash;/g, '—') // Replace em-dash
              .replace(/&hellip;/g, '…') // Replace ellipsis
              .replace(/&quot;/g, '"') // Replace quotes
              .replace(/&#0?39;/g, "'") // Replace apostrophe (with or without leading zero)
              .replace(/&#x27;/g, "'") // Replace hex-encoded apostrophe
              .replace(/&amp;/g, '&') // Replace ampersand (do this last)
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>');

            // Extract list name (everything before " • Letterboxd" or ", a list of films by")
            const patterns = [
              /^(.*?),\s*a\s+list\s+of\s+films?\s+by/i, // ", a list of films by"
              /^(.*?)\s*•\s*Letterboxd/i, // " • Letterboxd"
              /^(.*?)\s*-\s*Letterboxd/i, // " - Letterboxd"
              /^(.*?)\s*\|\s*Letterboxd/i, // " | Letterboxd"
            ];

            for (const pattern of patterns) {
              const match = rawTitle.match(pattern);
              if (match && match[1]) {
                return match[1].trim();
              }
            }

            // If no pattern matched, use fallback cleanup
            return rawTitle
              .replace(/\s*•\s*Letterboxd.*$/i, '') // Remove " • Letterboxd" suffix
              .replace(/\s*-\s*Letterboxd.*$/i, '') // Remove " - Letterboxd" suffix
              .replace(/\s*\|\s*Letterboxd.*$/i, '') // Remove " | Letterboxd" suffix
              .trim();
          }

          return 'Letterboxd List';
        }

        default:
          return 'Random List';
      }
    } catch (error) {
      logger.warn(`Failed to extract title from ${sourceType} URL: ${url}`, {
        label: 'RandomListManager',
        sourceType,
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      return `${sourceType.charAt(0).toUpperCase() + sourceType.slice(1)} List`;
    }
  }

  /**
   * Get a random URL from available lists for a source type
   * Validates that the URL contains enough items of the target media type
   */
  public static async getRandomUrl(
    sourceType: 'trakt' | 'tmdb' | 'imdb' | 'letterboxd',
    maxItems: number,
    targetMediaType?: 'movie' | 'tv',
    libraryCache?: LibraryItemsCache
  ): Promise<string | null> {
    const urls = await this.getRandomUrls(sourceType, targetMediaType);
    if (urls.length === 0) {
      logger.warn(`No random URLs available for source type: ${sourceType}`, {
        label: 'RandomListManager',
        sourceType,
      });
      return null;
    }

    // If no media type validation needed, use old behavior
    if (!targetMediaType) {
      const randomIndex = Math.floor(Math.random() * urls.length);
      const selectedUrl = urls[randomIndex];

      logger.info(`Selected random URL for ${sourceType}: ${selectedUrl}`, {
        label: 'RandomListManager',
        sourceType,
        selectedUrl,
        totalUrls: urls.length,
      });

      return selectedUrl;
    }

    // Early filtering for incompatible source/media type combinations
    if (
      (sourceType === 'letterboxd' || sourceType === 'tmdb') &&
      targetMediaType === 'tv'
    ) {
      logger.warn(
        `Source ${sourceType} does not support TV content, skipping validation attempts`,
        {
          label: 'RandomListManager',
          sourceType,
          targetMediaType,
        }
      );
      return null;
    }

    // For TMDB with library cache: use pre-filtered collections from user's library
    if (sourceType === 'tmdb' && libraryCache && targetMediaType === 'movie') {
      const libraryUrls = await this.getTmdbCollectionsFromLibrary(libraryCache);
      if (libraryUrls.length > 0) {
        const randomIndex = Math.floor(Math.random() * libraryUrls.length);
        const selectedUrl = libraryUrls[randomIndex];
        logger.info(
          `Selected TMDB collection from user library: ${selectedUrl}`,
          {
            label: 'RandomListManager',
            selectedUrl,
            candidateCount: libraryUrls.length,
          }
        );
        return selectedUrl;
      }
    }

    // Try up to 500 random URLs to find one suitable for target media type
    const maxAttempts = Math.min(500, urls.length);
    const triedUrls = new Set<string>();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let randomIndex: number;
      let selectedUrl: string;

      // Find an untried URL
      do {
        randomIndex = Math.floor(Math.random() * urls.length);
        selectedUrl = urls[randomIndex];
      } while (triedUrls.has(selectedUrl) && triedUrls.size < urls.length);

      triedUrls.add(selectedUrl);

      logger.debug(
        `Validating random URL (attempt ${attempt + 1}): ${selectedUrl}`,
        {
          label: 'RandomListManager',
          sourceType,
          targetMediaType,
          maxItems,
        }
      );

      // Validate this URL has enough items of target type
      try {
        const isValid = await this.validateUrlForMediaType(
          selectedUrl,
          sourceType,
          targetMediaType,
          maxItems,
          libraryCache
        );

        if (isValid) {
          logger.info(
            `Selected validated random URL for ${sourceType}: ${selectedUrl}`,
            {
              label: 'RandomListManager',
              sourceType,
              targetMediaType,
              selectedUrl,
              attempt: attempt + 1,
            }
          );

          return selectedUrl;
        }
      } catch (error) {
        logger.debug(`Failed to validate URL ${selectedUrl}:`, {
          label: 'RandomListManager',
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue to next URL
      }
    }

    logger.warn(
      `Could not find valid random URL for ${sourceType} with ${targetMediaType} content after ${maxAttempts} attempts`,
      {
        label: 'RandomListManager',
        sourceType,
        targetMediaType,
        maxItems,
        triedUrls: triedUrls.size,
      }
    );

    return null;
  }

  /**
   * Get dynamically discovered URLs for a source type
   */
  private static async getDiscoveredUrls(
    sourceType: 'trakt' | 'tmdb' | 'imdb' | 'letterboxd',
    targetMediaType?: 'movie' | 'tv'
  ): Promise<string[]> {
    const now = Date.now();
    const cacheKey = targetMediaType
      ? `${sourceType}-${targetMediaType}`
      : sourceType;
    const cached = this.discoveryCache.get(cacheKey);

    // Return cached results if still valid
    if (cached && now < cached.nextRefresh) {
      logger.debug(`Using cached discovered lists for ${sourceType}`, {
        label: 'RandomListManager',
        sourceType,
        count: cached.urls.length,
        cacheAge: Math.round((now - cached.lastDiscovered) / (1000 * 60 * 60)),
      });
      return cached.urls;
    }

    // Discover new lists
    logger.info(`Discovering new random lists for ${sourceType}...`, {
      label: 'RandomListManager',
      sourceType,
    });

    try {
      const discoveredUrls = await this.discoverLists(
        sourceType,
        targetMediaType
      );

      if (discoveredUrls.length > 0) {
        this.discoveryCache.set(cacheKey, {
          urls: discoveredUrls,
          lastDiscovered: now,
          nextRefresh: now + this.DISCOVERY_CACHE_TTL,
        });
      } else {
        // Negative cache: prevent retry storms when discovery is broken
        const prevFailures = cached?.failureCount ?? 0;
        this.discoveryCache.set(cacheKey, {
          urls: [],
          lastDiscovered: now,
          nextRefresh: now + this.NEGATIVE_CACHE_TTL,
          failureCount: prevFailures + 1,
        });
        logger.warn(
          `Discovery returned 0 results for ${sourceType}, negative-caching for ${
            this.NEGATIVE_CACHE_TTL / 3600000
          }h (failure #${prevFailures + 1})`,
          {
            label: 'RandomListManager',
            sourceType,
          }
        );
      }

      logger.info(
        `Discovered ${discoveredUrls.length} lists for ${sourceType}`,
        {
          label: 'RandomListManager',
          sourceType,
          count: discoveredUrls.length,
        }
      );

      return discoveredUrls;
    } catch (error) {
      logger.error(`Failed to discover lists for ${sourceType}`, {
        label: 'RandomListManager',
        sourceType,
        error: error instanceof Error ? error.message : String(error),
      });

      // Negative cache the error to prevent retry storms
      const prevFailures = cached?.failureCount ?? 0;
      this.discoveryCache.set(cacheKey, {
        urls: [],
        lastDiscovered: now,
        nextRefresh: now + this.NEGATIVE_CACHE_TTL,
        failureCount: prevFailures + 1,
      });

      // Return cached results if available, even if expired
      if (cached && cached.urls.length > 0) {
        logger.warn(
          `Using expired cache for ${sourceType} due to discovery failure`,
          {
            label: 'RandomListManager',
            sourceType,
            count: cached.urls.length,
          }
        );
        return cached.urls;
      }

      return [];
    }
  }

  /**
   * Discover lists dynamically for each source type
   */
  private static async discoverLists(
    sourceType: 'trakt' | 'tmdb' | 'imdb' | 'letterboxd',
    targetMediaType?: 'movie' | 'tv'
  ): Promise<string[]> {
    switch (sourceType) {
      case 'trakt':
        return this.discoverTraktLists();
      case 'tmdb':
        return this.discoverTmdbCollections();
      case 'imdb':
        return this.discoverImdbLists(targetMediaType);
      case 'letterboxd':
        return this.discoverLetterboxdLists();
      default:
        throw new Error(`Unknown source type: ${sourceType}`);
    }
  }

  /**
   * Discover Trakt lists using API endpoints
   */
  private static async discoverTraktLists(): Promise<string[]> {
    try {
      const { getSettings } = await import('@server/lib/settings');
      const settings = getSettings();
      const apiKey = settings.trakt.clientId || settings.trakt.apiKey;

      if (!apiKey) {
        logger.warn('Trakt API key not configured, skipping list discovery', {
          label: 'RandomListManager',
        });
        return [];
      }

      const { default: TraktAPI } = await import('@server/api/trakt');
      const traktClient = new TraktAPI({
        clientId: apiKey,
        accessToken: settings.trakt.accessToken,
        clientSecret: settings.trakt.clientSecret,
        refreshToken: settings.trakt.refreshToken,
        tokenExpiresAt: settings.trakt.tokenExpiresAt,
        redirectUri: buildTraktRedirectUri(settings),
        onTokenRefreshed: (tokens) => persistTraktTokens(settings, tokens),
      });

      const discoveredUrls: string[] = [];

      // 1. Get popular lists
      try {
        const popularLists = await traktClient.getPopularLists(50);
        for (const list of popularLists) {
          // API returns TraktListSummary directly
          if (list && list.privacy === 'public' && list.item_count > 10) {
            const url = `https://trakt.tv/users/${list.user.username}/lists/${list.ids.slug}`;
            discoveredUrls.push(url);
          }
        }
        logger.debug(`Found ${popularLists.length} popular Trakt lists`, {
          label: 'RandomListManager',
          added: popularLists.filter(
            (list) => list?.privacy === 'public' && list?.item_count > 10
          ).length,
        });
      } catch (error) {
        logger.warn('Failed to fetch popular Trakt lists', {
          label: 'RandomListManager',
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // 2. Get trending lists
      try {
        const trendingLists = await traktClient.getTrendingLists(50);
        for (const list of trendingLists) {
          // API returns TraktListSummary directly
          if (list && list.privacy === 'public' && list.item_count > 10) {
            const url = `https://trakt.tv/users/${list.user.username}/lists/${list.ids.slug}`;
            if (!discoveredUrls.includes(url)) {
              discoveredUrls.push(url);
            }
          }
        }
        logger.debug(`Found ${trendingLists.length} trending Trakt lists`, {
          label: 'RandomListManager',
          newAdded: trendingLists.filter((list) => {
            return (
              list?.privacy === 'public' &&
              list?.item_count > 10 &&
              !discoveredUrls.includes(
                `https://trakt.tv/users/${list.user.username}/lists/${list.ids.slug}`
              )
            );
          }).length,
        });
      } catch (error) {
        logger.warn('Failed to fetch trending Trakt lists', {
          label: 'RandomListManager',
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // 3. Get lists from known active users
      const popularUsernames = [
        'justin',
        'giladg',
        'sp1ti',
        'hdlists',
        'movistapp',
        'donxy',
      ];
      for (const username of popularUsernames) {
        try {
          const userLists = await traktClient.getUserLists(username, 20);
          for (const list of userLists) {
            if (list.privacy === 'public' && list.item_count > 10) {
              const url = `https://trakt.tv/users/${username}/lists/${list.ids.slug}`;
              if (!discoveredUrls.includes(url)) {
                discoveredUrls.push(url);
              }
            }
          }
        } catch (error) {
          logger.debug(`Failed to fetch lists for user ${username}`, {
            label: 'RandomListManager',
            username,
            error: error instanceof Error ? error.message : String(error),
          });
          // Continue with other users
        }
      }

      logger.info(`Discovered ${discoveredUrls.length} Trakt lists`, {
        label: 'RandomListManager',
        count: discoveredUrls.length,
      });

      return discoveredUrls;
    } catch (error) {
      logger.error('Failed to discover Trakt lists', {
        label: 'RandomListManager',
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Discover TMDB collections using daily exports with quality pre-filtering
   * Strategy: Download daily collection IDs export, filter for quality, cache results
   */
  private static async discoverTmdbCollections(): Promise<string[]> {
    // Check if we have valid cached filtered collections
    const now = Date.now();
    if (this.tmdbFilteredCache && now < this.tmdbFilteredCache.nextRefresh) {
      logger.debug('Using cached filtered TMDB collections', {
        label: 'RandomListManager',
        cachedCount: this.tmdbFilteredCache.collections.length,
        cacheAge: Math.round(
          (now - this.tmdbFilteredCache.lastFiltered) / (1000 * 60 * 60 * 24)
        ),
      });

      return this.tmdbFilteredCache.collections.map(
        (c) => `https://www.themoviedb.org/collection/${c.id}`
      );
    }

    // Need to fetch and filter collections
    try {
      const axios = (await import('axios')).default;

      // TMDB exports publish ~7AM UTC daily. Use UTC dates and try yesterday first,
      // then day-before-yesterday to handle the pre-publication window.
      const formatTmdbDate = (daysAgo: number): string => {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - daysAgo);
        return `${String(d.getUTCMonth() + 1).padStart(2, '0')}_${String(
          d.getUTCDate()
        ).padStart(2, '0')}_${d.getUTCFullYear()}`;
      };

      // eslint-disable-next-line @typescript-eslint/consistent-type-imports
      let response: import('axios').AxiosResponse | undefined;
      let exportUrl = '';
      for (const daysAgo of [1, 2]) {
        const dateStr = formatTmdbDate(daysAgo);
        exportUrl = `http://files.tmdb.org/p/exports/collection_ids_${dateStr}.json.gz`;

        try {
          response = await axios.get(exportUrl, {
            headers: { 'Accept-Encoding': 'gzip' },
            responseType: 'stream',
            timeout: 30000,
          });
          break;
        } catch (fetchError) {
          if (daysAgo === 2) throw fetchError;
          logger.debug(
            `TMDB export for ${dateStr} not available, trying day before`,
            { label: 'RandomListManager' }
          );
        }
      }

      if (!response) throw new Error('Failed to fetch TMDB daily export');
      const tmdbResponse = response;

      logger.debug('Fetching TMDB collection IDs from daily export', {
        label: 'RandomListManager',
        url: exportUrl,
      });

      // Parse the JSONL format (one JSON object per line)
      const collections: { id: number; name: string }[] = [];
      const chunks: Buffer[] = [];

      tmdbResponse.data.on('data', (chunk: Buffer) => chunks.push(chunk));

      await new Promise((resolve, reject) => {
        tmdbResponse.data.on('end', () => resolve(undefined));
        tmdbResponse.data.on('error', reject);
      });

      const buffer = Buffer.concat(chunks);
      const zlib = await import('zlib');
      const decompressed = zlib.gunzipSync(buffer);
      const lines = decompressed.toString('utf8').trim().split('\n');

      for (const line of lines) {
        try {
          const collection = JSON.parse(line);
          if (collection.id && collection.name) {
            collections.push(collection);
          }
        } catch (parseError) {
          // Skip malformed lines
          continue;
        }
      }

      logger.info(
        `Loaded ${collections.length} collections from TMDB daily export`,
        {
          label: 'RandomListManager',
          totalCollections: collections.length,
        }
      );

      // Cache all collections (no pre-filtering - we'll pick random ones during sync)
      this.tmdbFilteredCache = {
        collections: collections,
        lastFiltered: now,
        nextRefresh: now + this.TMDB_FILTERED_CACHE_TTL,
      };

      logger.info(`TMDB collections cached for 30 days`, {
        label: 'RandomListManager',
        cachedCount: collections.length,
      });

      // Return URLs for all collections (random selection happens during validation)
      return collections.map(
        (c) => `https://www.themoviedb.org/collection/${c.id}`
      );
    } catch (error) {
      logger.error('Failed to discover TMDB collections from daily export', {
        label: 'RandomListManager',
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Build a pool of TMDB collection URLs from the user's Plex library.
   * Samples library movies, looks up belongs_to_collection via TMDB API,
   * then verifies each collection has ≥2 matches in the full library.
   */
  private static async getTmdbCollectionsFromLibrary(
    libraryCache: LibraryItemsCache
  ): Promise<string[]> {
    const now = Date.now();
    if (
      this.tmdbLibraryCollectionsCache &&
      now < this.tmdbLibraryCollectionsCache.nextRefresh
    ) {
      return this.tmdbLibraryCollectionsCache.urls;
    }

    // Deduplicate concurrent callers
    if (this.tmdbLibraryBuildPromise) {
      return this.tmdbLibraryBuildPromise;
    }

    this.tmdbLibraryBuildPromise = this.buildTmdbCollectionsFromLibrary(
      libraryCache,
      now
    ).finally(() => {
      this.tmdbLibraryBuildPromise = null;
    });

    return this.tmdbLibraryBuildPromise;
  }

  private static async buildTmdbCollectionsFromLibrary(
    libraryCache: LibraryItemsCache,
    now: number
  ): Promise<string[]> {
    try {
      const { default: TmdbAPI } = await import('@server/api/themoviedb');
      const tmdbClient = new TmdbAPI();

      // Extract TMDB IDs from movie items only (skip TV — they lack belongs_to_collection)
      const movieTmdbIds = new Set<number>();
      for (const libraryKey of Object.keys(libraryCache)) {
        for (const item of libraryCache[libraryKey]) {
          if (!item.Guid) continue;
          const hasTvdb = item.Guid.some((g) => g.id.startsWith('tvdb://'));
          if (hasTvdb) continue;
          for (const guid of item.Guid) {
            if (guid.id.startsWith('tmdb://')) {
              const id = parseInt(guid.id.replace('tmdb://', ''), 10);
              if (!isNaN(id)) movieTmdbIds.add(id);
            }
          }
        }
      }

      if (movieTmdbIds.size === 0) {
        this.cacheTmdbLibraryResult([], now);
        return [];
      }

      // Shuffle and sample up to 150 unique movies
      const shuffled = Array.from(movieTmdbIds);
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const sample = shuffled.slice(0, 150);

      // Map each sampled movie to its collection ID (if any)
      const movieToCollection = new Map<number, number>();
      const results = await Promise.allSettled(
        sample.map((tmdbId) =>
          tmdbClient
            .getMovie({ movieId: tmdbId })
            .then((movie) => ({ tmdbId, collection: movie.belongs_to_collection }))
        )
      );

      const rejected = results.filter((r) => r.status === 'rejected').length;
      if (rejected > 0) {
        logger.warn(
          `TMDB library collection lookup: ${rejected}/${results.length} requests failed`,
          { label: 'RandomListManager' }
        );
      }

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.collection?.id) {
          movieToCollection.set(result.value.tmdbId, result.value.collection.id);
        }
      }

      // For each discovered collection, verify ≥2 movies exist in the full library
      const collectionIds = new Set(movieToCollection.values());
      const collectionMembers = new Map<number, number>();

      for (const collId of collectionIds) {
        collectionMembers.set(collId, 0);
      }

      // Fetch collection details to get all member movie IDs, then check against library
      const collectionResults = await Promise.allSettled(
        Array.from(collectionIds).map((collId) =>
          tmdbClient
            .getCollection({ collectionId: collId })
            .then((coll) => ({
              collId,
              parts: (coll.parts || [])
                .filter((p: { id?: number }) => p?.id)
                .map((p: { id?: number }) => p.id as number),
            }))
        )
      );

      const validCollectionIds: number[] = [];
      for (const result of collectionResults) {
        if (result.status !== 'fulfilled') continue;
        const { collId, parts } = result.value;
        const matchCount = parts.filter((id: number) => movieTmdbIds.has(id)).length;
        if (matchCount >= 2) {
          validCollectionIds.push(collId);
        }
      }

      const urls = validCollectionIds.map(
        (id) => `https://www.themoviedb.org/collection/${id}`
      );

      logger.info(
        `Built TMDB collection pool from library: ${urls.length} collections (${collectionIds.size} discovered, ${urls.length} with ≥2 Plex matches) from ${sample.length} sampled movies`,
        {
          label: 'RandomListManager',
          validCollections: urls.length,
          discoveredCollections: collectionIds.size,
          sampledMovies: sample.length,
          totalLibraryMovies: movieTmdbIds.size,
          failedLookups: rejected,
        }
      );

      this.cacheTmdbLibraryResult(urls, now);
      return urls;
    } catch (error) {
      logger.warn('Failed to build TMDB collections from library', {
        label: 'RandomListManager',
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private static cacheTmdbLibraryResult(urls: string[], now: number): void {
    this.tmdbLibraryCollectionsCache = {
      urls,
      lastBuilt: now,
      nextRefresh:
        now +
        (urls.length > 0
          ? this.TMDB_LIBRARY_CACHE_TTL
          : this.TMDB_LIBRARY_NEGATIVE_TTL),
    };
  }

  /**
   * Discover IMDb lists by scraping user lists page via ImdbAxiosClient (WAF-aware)
   * Strategy: Fetch paginated user lists page, parse __NEXT_DATA__ JSON or fall back to regex
   */
  private static async discoverImdbLists(
    targetMediaType?: 'movie' | 'tv'
  ): Promise<string[]> {
    const userId = 'ur23892615';
    const baseUrl = `https://www.imdb.com/user/${userId}/lists/`;

    const tvKeywords = [
      'tv',
      'television',
      'show',
      'shows',
      'series',
      'season',
      'seasons',
    ];

    try {
      const { ImdbAxiosClient } = await import(
        '@server/lib/collections/utils/ImdbAxiosClient'
      );
      const axiosInstance = await ImdbAxiosClient.getInstance();
      const discoveredUrls = new Set<string>();

      let page = 1;
      const maxPages = 10;

      logger.debug('Discovering IMDb lists via HTML scraping', {
        label: 'RandomListManager',
        userId,
        maxPages,
        targetMediaType,
      });

      while (page <= maxPages) {
        const pageUrl = page === 1 ? baseUrl : `${baseUrl}?page=${page}`;

        try {
          const response = await axiosInstance.get(pageUrl, { timeout: 20000 });
          const html = response.data;

          // Strategy 1: Parse __NEXT_DATA__ for structured list data
          const nextDataMatch = html.match(
            /<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s
          );

          let foundOnPage = 0;

          if (nextDataMatch) {
            try {
              const nextData = JSON.parse(nextDataMatch[1]);
              const listSearch =
                nextData?.props?.pageProps?.mainColumnData?.lists
                  ?.titleListItemSearch ??
                nextData?.props?.pageProps?.mainColumnData?.userListSearch;

              if (listSearch?.edges) {
                for (const edge of listSearch.edges) {
                  const node = edge.node ?? edge.listItem;
                  if (!node) continue;
                  const listId = node?.id ?? node?.listId;
                  if (!listId || !listId.startsWith('ls')) continue;

                  const rawName =
                    node?.name?.originalText ?? node?.listName ?? '';
                  const name = typeof rawName === 'string' ? rawName : '';
                  const url = `https://www.imdb.com/list/${listId}/`;

                  if (targetMediaType === 'tv') {
                    if (name.length === 0) continue;
                    const titleLower = name.toLowerCase();
                    if (
                      !tvKeywords.some((keyword) =>
                        titleLower.includes(keyword)
                      )
                    ) {
                      continue;
                    }
                  }

                  discoveredUrls.add(url);
                  foundOnPage++;
                }
              }
            } catch (parseError) {
              logger.debug(
                'Failed to parse __NEXT_DATA__ for IMDb lists page, trying regex fallback',
                {
                  label: 'RandomListManager',
                  page,
                  error:
                    parseError instanceof Error
                      ? parseError.message
                      : String(parseError),
                }
              );
            }
          }

          // Strategy 2: Regex fallback — scan raw HTML for list links
          if (foundOnPage === 0) {
            const listRegex = /href="\/list\/(ls\d+)\/?"/g;
            let match;
            while ((match = listRegex.exec(html)) !== null) {
              const url = `https://www.imdb.com/list/${match[1]}/`;
              discoveredUrls.add(url);
              foundOnPage++;
            }
          }

          if (foundOnPage === 0) {
            logger.debug(
              `No lists found on IMDb page ${page}, stopping pagination`,
              { label: 'RandomListManager' }
            );
            break;
          }

          page++;

          if (page <= maxPages) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        } catch (error) {
          logger.warn(`Failed to fetch IMDb lists page ${page}`, {
            label: 'RandomListManager',
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }
      }

      const result = Array.from(discoveredUrls);

      logger.info(
        `Discovered ${result.length} IMDb lists via HTML scraping (${
          page - 1
        } pages)`,
        {
          label: 'RandomListManager',
          count: result.length,
          pagesProcessed: page - 1,
          targetMediaType,
        }
      );

      return result;
    } catch (error) {
      logger.error('Failed to discover IMDb lists', {
        label: 'RandomListManager',
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Discover Letterboxd lists using random page strategy
   * Strategy: Random page (1-250) from https://letterboxd.com/lists/popular/page/{N}/
   */
  private static async discoverLetterboxdLists(): Promise<string[]> {
    try {
      // Pick 3 random pages from the 250 available to get good variety
      const scrapedPages = new Set<number>();
      while (scrapedPages.size < 3) {
        scrapedPages.add(Math.floor(Math.random() * 250) + 1);
      }

      const pageUrls = Array.from(scrapedPages).map((p) =>
        p === 1
          ? 'https://letterboxd.com/lists/popular/'
          : `https://letterboxd.com/lists/popular/page/${p}/`
      );

      logger.debug(`Scraping ${pageUrls.length} Letterboxd discovery pages`, {
        label: 'RandomListManager',
        pages: Array.from(scrapedPages),
      });

      const { getSettings } = await import('@server/lib/settings');
      const usePlainHttp = getSettings().main.letterboxdUsePlainHttp ?? false;

      const discoveredUrls = new Set<string>();
      const listUrlRegex = /href="(\/[^/]+\/list\/[^/]+\/)"[^>]*>/g;

      if (usePlainHttp) {
        const { LetterboxdHttpClient } = await import(
          '@server/lib/collections/utils/LetterboxdHttpClient'
        );
        for (const pageUrl of pageUrls) {
          try {
            const html = await LetterboxdHttpClient.fetchPage(pageUrl);
            let match;
            const regex = new RegExp(listUrlRegex.source, 'g');
            while ((match = regex.exec(html)) !== null) {
              discoveredUrls.add(`https://letterboxd.com${match[1]}`);
            }
          } catch (error) {
            logger.debug(`Failed to fetch Letterboxd page ${pageUrl}`, {
              label: 'RandomListManager',
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } else {
        const { CloudflareSolver } = await import(
          '@server/lib/collections/utils/CloudflareSolver'
        );
        const htmlMap = await CloudflareSolver.fetchPagesBatch(pageUrls, 3);
        for (const [, html] of htmlMap) {
          let match;
          const regex = new RegExp(listUrlRegex.source, 'g');
          while ((match = regex.exec(html)) !== null) {
            discoveredUrls.add(`https://letterboxd.com${match[1]}`);
          }
        }
      }

      const result = Array.from(discoveredUrls);

      logger.info(
        `Discovered ${result.length} Letterboxd lists from ${scrapedPages.size} pages`,
        {
          label: 'RandomListManager',
          count: result.length,
          pagesScraped: Array.from(scrapedPages),
        }
      );

      return result;
    } catch (error) {
      logger.error('Failed to discover Letterboxd lists', {
        label: 'RandomListManager',
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Read and parse config file for a source type
   */
  private static readConfig(
    sourceType: 'trakt' | 'tmdb' | 'imdb' | 'letterboxd'
  ): { enabled: boolean; urls: string[] } {
    const now = Date.now();
    const cached = this.cache.get(sourceType);

    // Return cached result if still valid
    if (cached && now - cached.lastRead < this.CACHE_TTL) {
      return { enabled: cached.enabled, urls: cached.urls };
    }

    const configPath = path.join(this.configDir, `${sourceType}.txt`);

    // Return disabled state if file doesn't exist
    if (!fs.existsSync(configPath)) {
      logger.warn(`Random list config file not found: ${configPath}`, {
        label: 'RandomListManager',
        sourceType,
      });

      const result = { enabled: false, urls: [] };
      this.cache.set(sourceType, { ...result, lastRead: now });
      return result;
    }

    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const config = this.parseConfig(content);

      logger.debug(`Loaded random list config for ${sourceType}`, {
        label: 'RandomListManager',
        sourceType,
        enabled: config.enabled,
        urlCount: config.urls.length,
      });

      // Cache the result
      this.cache.set(sourceType, { ...config, lastRead: now });

      return config;
    } catch (error) {
      logger.error(
        `Failed to read random list config for ${sourceType}: ${error}`,
        {
          label: 'RandomListManager',
          sourceType,
          error: error instanceof Error ? error.message : String(error),
        }
      );

      const result = { enabled: false, urls: [] };
      this.cache.set(sourceType, { ...result, lastRead: now });
      return result;
    }
  }

  /**
   * Parse config file content
   * Expected format:
   * enabled=true
   * # Comment
   * https://example.com/list1
   * https://example.com/list2
   */
  private static parseConfig(content: string): {
    enabled: boolean;
    urls: string[];
  } {
    const lines = content.split('\n').map((line) => line.trim());

    let enabled = false;
    const urls: string[] = [];

    for (const line of lines) {
      // Skip empty lines and comments
      if (!line || line.startsWith('#')) {
        continue;
      }

      // Parse enabled flag
      if (line.startsWith('enabled=')) {
        const value = line.substring('enabled='.length).toLowerCase();
        enabled = value === 'true';
        continue;
      }

      // Parse URLs - basic validation
      if (line.startsWith('http://') || line.startsWith('https://')) {
        urls.push(line);
      }
    }

    return { enabled, urls };
  }

  /**
   * Clear cache for a specific source type or all cache
   */
  public static clearCache(
    sourceType?: 'trakt' | 'tmdb' | 'imdb' | 'letterboxd'
  ): void {
    if (sourceType) {
      this.cache.delete(sourceType);
    } else {
      this.cache.clear();
    }

    logger.debug('Cleared random list cache', {
      label: 'RandomListManager',
      sourceType: sourceType || 'all',
    });
  }

  /**
   * Get cache statistics for debugging
   */
  public static getCacheStats(): Record<
    string,
    {
      enabled: boolean;
      urls: string[];
      lastUpdated: Date;
    }
  > {
    const stats: Record<
      string,
      {
        enabled: boolean;
        urls: string[];
        lastUpdated: Date;
      }
    > = {};

    for (const [sourceType, cached] of this.cache.entries()) {
      stats[sourceType] = {
        enabled: cached.enabled,
        urls: cached.urls,
        lastUpdated: new Date(cached.lastRead),
      };
    }

    return stats;
  }

  /**
   * Validate that a URL contains enough items of the target media type
   */
  private static async validateUrlForMediaType(
    url: string,
    sourceType: 'trakt' | 'tmdb' | 'imdb' | 'letterboxd',
    targetMediaType: 'movie' | 'tv',
    maxItems: number,
    libraryCache?: LibraryItemsCache
  ): Promise<boolean> {
    try {
      // Quick validation by analyzing URL patterns and making lightweight requests
      // We don't want to do full list processing here, just check media type compatibility

      switch (sourceType) {
        case 'trakt':
          return await this.validateTraktUrl(
            url,
            targetMediaType,
            maxItems,
            libraryCache
          );
        case 'tmdb':
          return await this.validateTmdbUrl(
            url,
            targetMediaType,
            maxItems,
            libraryCache
          );
        case 'imdb':
          return await this.validateImdbUrl(
            url,
            targetMediaType,
            maxItems,
            libraryCache
          );
        case 'letterboxd':
          return await this.validateLetterboxdUrl(
            url,
            targetMediaType,
            maxItems,
            libraryCache
          );
        default:
          return false;
      }
    } catch (error) {
      logger.debug(`URL validation failed for ${url}:`, {
        label: 'RandomListManager',
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Validate Trakt URL for media type compatibility
   */
  private static async validateTraktUrl(
    url: string,
    targetMediaType: 'movie' | 'tv',
    maxItems: number,
    libraryCache?: LibraryItemsCache
  ): Promise<boolean> {
    try {
      // Import TraktAPI to check the list
      const { getSettings } = await import('@server/lib/settings');
      const settings = getSettings();
      const apiKey = settings.trakt.clientId || settings.trakt.apiKey;

      if (!apiKey) {
        return false; // Can't validate without API key
      }

      const { default: TraktAPI } = await import('@server/api/trakt');
      const traktClient = new TraktAPI({
        clientId: apiKey,
        accessToken: settings.trakt.accessToken,
        clientSecret: settings.trakt.clientSecret,
        refreshToken: settings.trakt.refreshToken,
        tokenExpiresAt: settings.trakt.tokenExpiresAt,
        redirectUri: buildTraktRedirectUri(settings),
        onTokenRefreshed: (tokens) => persistTraktTokens(settings, tokens),
      });

      // Extract list slug from URL (e.g., https://trakt.tv/users/username/lists/listname or https://app.trakt.tv/users/username/lists/listname)
      const match = url.match(/\/users\/([^/]+)\/lists\/([^/?]+)/);
      if (!match) {
        return false;
      }

      const [, username, listSlug] = match;

      // Get list items with limit to check media types
      // Preserve original domain (trakt.tv or app.trakt.tv)
      const domain = url.includes('app.trakt.tv') ? 'app.trakt.tv' : 'trakt.tv';
      const listUrl = `https://${domain}/users/${username}/lists/${listSlug}`;
      const listItems = await traktClient.getCustomList(
        listUrl,
        Math.min(maxItems, 50)
      );

      // Filter items by target media type
      const targetItems = listItems.filter((item: TraktListResponse) => {
        return targetMediaType === 'movie' ? item.movie : item.show;
      });

      // Skip maxItems validation - let the normal collection filtering handle it
      // This allows smaller lists that would still produce valid collections

      // If library cache is provided, check that we have at least 4 items in Plex library
      if (libraryCache) {
        // Build efficient lookup sets from library cache
        const userTmdbIds = new Set<number>();
        const userTvdbIds = new Set<number>();
        const userImdbIds = new Set<string>();

        for (const libraryKey in libraryCache) {
          const libraryItems = libraryCache[libraryKey];
          for (const item of libraryItems) {
            if (item.Guid) {
              for (const guid of item.Guid) {
                if (guid.id.startsWith('tmdb://')) {
                  const tmdbId = parseInt(guid.id.replace('tmdb://', ''), 10);
                  if (!isNaN(tmdbId)) {
                    userTmdbIds.add(tmdbId);
                  }
                } else if (guid.id.startsWith('tvdb://')) {
                  const tvdbId = parseInt(guid.id.replace('tvdb://', ''), 10);
                  if (!isNaN(tvdbId)) {
                    userTvdbIds.add(tvdbId);
                  }
                } else if (guid.id.startsWith('imdb://')) {
                  const imdbId = guid.id.replace('imdb://', '');
                  userImdbIds.add(imdbId);
                }
              }
            }
          }
        }

        let plexMatchCount = 0;
        for (const item of targetItems) {
          const mediaItem =
            targetMediaType === 'movie' ? item.movie : item.show;
          if (!mediaItem || !mediaItem.ids) continue;

          // Check for matches using available IDs
          const tmdbId = mediaItem.ids.tmdb;
          const tvdbId =
            targetMediaType === 'tv'
              ? (mediaItem.ids as { tvdb?: number }).tvdb
              : undefined; // tvdb only exists on shows
          const imdbId = mediaItem.ids.imdb;

          if (
            (tmdbId && userTmdbIds.has(tmdbId)) ||
            (tvdbId && userTvdbIds.has(tvdbId)) ||
            (imdbId && userImdbIds.has(imdbId))
          ) {
            plexMatchCount++;
            if (plexMatchCount >= 4) {
              return true; // Found enough matches in Plex library!
            }
          }
        }

        // Need at least 4 matches in Plex library for custom lists
        return false;
      }

      // Fallback: if no library cache, just check media type compatibility
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Validate TMDB URL for media type compatibility
   */
  private static async validateTmdbUrl(
    url: string,
    targetMediaType: 'movie' | 'tv',
    maxItems: number,
    libraryCache?: LibraryItemsCache
  ): Promise<boolean> {
    try {
      // TMDB collections are movie-only by design
      if (targetMediaType === 'tv') {
        return false;
      }

      // Extract collection ID from URL
      const collectionIdMatch = url.match(/\/collection\/(\d+)/);
      if (!collectionIdMatch) {
        return false;
      }

      const collectionId = collectionIdMatch[1];

      // Import TMDB API to check the collection
      const { default: TmdbAPI } = await import('@server/api/themoviedb');
      const tmdbClient = new TmdbAPI();

      // Get collection details
      const collectionData: {
        parts?: { id?: number; release_date?: string }[];
      } = await tmdbClient.getCollection({
        collectionId: parseInt(collectionId, 10),
      });

      if (!collectionData || !collectionData.parts) {
        return false;
      }

      // Count valid movie items (filter out any invalid entries)
      const validMovieCount = collectionData.parts.filter(
        (part: { id?: number; release_date?: string }) =>
          part && part.id && part.release_date
      ).length;

      // For franchise collections, check we have at least 2 items in Plex library
      if (libraryCache) {
        // Build efficient TMDB ID lookup set from library cache
        const userTmdbIds = new Set<number>();
        for (const libraryKey in libraryCache) {
          const libraryItems = libraryCache[libraryKey];
          for (const item of libraryItems) {
            if (item.Guid) {
              for (const guid of item.Guid) {
                if (guid.id.startsWith('tmdb://')) {
                  const tmdbId = parseInt(guid.id.replace('tmdb://', ''), 10);
                  if (!isNaN(tmdbId)) {
                    userTmdbIds.add(tmdbId);
                  }
                }
              }
            }
          }
        }

        let plexMatchCount = 0;
        for (const part of collectionData.parts) {
          if (!part || !part.id) continue;

          // Fast O(1) lookup using Set
          if (userTmdbIds.has(part.id)) {
            plexMatchCount++;
            if (plexMatchCount >= 2) {
              return true; // Found a suitable franchise collection!
            }
          }
        }

        // Need at least 2 matches in Plex library for franchise collections
        return false;
      }

      // Fallback: if no library cache, just check it's a valid movie collection
      return targetMediaType === 'movie' && validMovieCount >= 2;
    } catch (error) {
      return false;
    }
  }

  /**
   * Validate IMDb URL for media type compatibility
   */
  private static async validateImdbUrl(
    url: string,
    targetMediaType: 'movie' | 'tv',
    maxItems: number,
    libraryCache?: LibraryItemsCache
  ): Promise<boolean> {
    try {
      // If library cache is provided, check that we have at least 4 items in Plex library
      if (libraryCache) {
        // Use ImdbAxiosClient which has WAF token cookies (same as actual sync)
        const { ImdbAxiosClient } = await import(
          '@server/lib/collections/utils/ImdbAxiosClient'
        );
        const axiosInstance = await ImdbAxiosClient.getInstance();

        // Fetch the IMDb list page
        const response = await axiosInstance.get(url, {
          timeout: 15000,
        });

        // Parse using __NEXT_DATA__ parser (same as actual sync for custom lists)
        const ImdbCollections = await import(
          '@server/lib/collections/sources/imdb'
        );
        const imdbCollections = new ImdbCollections.default();
        const pageData = imdbCollections.parseNextDataFromHtml(
          response.data,
          'validation'
        );
        const imdbItems = pageData ? pageData.items : [];

        // Filter items by target media type
        const targetItems = imdbItems.filter((item) => {
          return targetMediaType === 'movie'
            ? item.type === 'movie'
            : item.type === 'tv';
        });

        // Skip maxItems validation - let the normal collection filtering handle it
        // This allows smaller lists that would still produce valid collections

        // Build efficient TMDB ID lookup set from library cache
        const userTmdbIds = new Set<number>();

        for (const libraryKey in libraryCache) {
          const libraryItems = libraryCache[libraryKey];
          for (const item of libraryItems) {
            if (item.Guid) {
              for (const guid of item.Guid) {
                if (guid.id.startsWith('tmdb://')) {
                  const tmdbId = parseInt(guid.id.replace('tmdb://', ''), 10);
                  if (!isNaN(tmdbId)) {
                    userTmdbIds.add(tmdbId);
                  }
                }
              }
            }
          }
        }

        // For IMDb validation, we need to resolve TMDB IDs like the actual sync process does
        const ImdbCollectionsModule = await import(
          '@server/lib/collections/sources/imdb'
        );
        const imdbValidator = new ImdbCollectionsModule.default();

        let plexMatchCount = 0;
        for (const item of targetItems) {
          try {
            // Resolve TMDB ID from IMDb ID (same logic as actual sync)
            const { episodeTmdbId } =
              await imdbValidator.resolveEpisodeAndShowTmdbIds(
                item.imdbId,
                item.type
              );
            const tmdbId = episodeTmdbId;

            // Check if this TMDB ID exists in user's Plex library
            if (tmdbId && userTmdbIds.has(tmdbId)) {
              plexMatchCount++;
              if (plexMatchCount >= 4) {
                return true; // Found enough matches in Plex library!
              }
            }
          } catch (error) {
            // Skip items that fail TMDB ID resolution
            continue;
          }
        }

        // Need at least 4 matches in Plex library for custom lists
        return false;
      }

      // Fallback: if no library cache, assume IMDb lists can contain both movies and TV shows
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Validate Letterboxd URL for media type compatibility
   */
  private static async validateLetterboxdUrl(
    url: string,
    targetMediaType: 'movie' | 'tv',
    maxItems: number,
    libraryCache?: LibraryItemsCache
  ): Promise<boolean> {
    try {
      // Letterboxd is movie-only, so only valid for movie collections
      if (targetMediaType !== 'movie') {
        return false;
      }

      // If library cache is provided, check that we have at least 4 items in Plex library
      if (libraryCache) {
        const { getSettings } = await import('@server/lib/settings');
        const usePlainHttpValidation =
          getSettings().main.letterboxdUsePlainHttp ?? false;
        let html: string;
        if (usePlainHttpValidation) {
          const { LetterboxdHttpClient } = await import(
            '@server/lib/collections/utils/LetterboxdHttpClient'
          );
          html = await LetterboxdHttpClient.fetchPage(url);
        } else {
          const { CloudflareSolver } = await import(
            '@server/lib/collections/utils/CloudflareSolver'
          );
          html = await CloudflareSolver.fetchPage(url);
        }

        // Parse the HTML to extract Letterboxd items using the proper parser
        const LetterboxdCollections = await import(
          '@server/lib/collections/sources/letterboxd'
        );
        const letterboxdCollections =
          new LetterboxdCollections.LetterboxdCollectionSync();
        const letterboxdItems = letterboxdCollections.parseLetterboxdListHtml(
          html,
          Math.min(maxItems, 50)
        );

        // Skip maxItems validation - let the normal collection filtering handle it
        // This allows smaller lists that would still produce valid collections

        // Build efficient lookup sets from library cache
        const userTmdbIds = new Set<number>();
        const userImdbIds = new Set<string>();

        for (const libraryKey in libraryCache) {
          const libraryItems = libraryCache[libraryKey];
          for (const item of libraryItems) {
            if (item.Guid) {
              for (const guid of item.Guid) {
                if (guid.id.startsWith('tmdb://')) {
                  const tmdbId = parseInt(guid.id.replace('tmdb://', ''), 10);
                  if (!isNaN(tmdbId)) {
                    userTmdbIds.add(tmdbId);
                  }
                } else if (guid.id.startsWith('imdb://')) {
                  const imdbId = guid.id.replace('imdb://', '');
                  userImdbIds.add(imdbId);
                }
              }
            }
          }
        }

        // For Letterboxd validation, resolve TMDB IDs in batches of 25 concurrently
        const { default: TmdbAPI } = await import('@server/api/themoviedb');
        const tmdbClient = new TmdbAPI();

        const batchSize = 25;
        let plexMatchCount = 0;

        for (let i = 0; i < letterboxdItems.length; i += batchSize) {
          const batch = letterboxdItems.slice(i, i + batchSize);
          const batchIds = await Promise.all(
            batch.map(async (item) => {
              try {
                const searchResults = await tmdbClient.searchMovies({
                  query: item.title,
                  year: item.year,
                });
                if (searchResults.results && searchResults.results.length > 0) {
                  return searchResults.results[0].id;
                }
                return null;
              } catch {
                return null;
              }
            })
          );

          plexMatchCount += batchIds.filter(
            (id) => id !== null && userTmdbIds.has(id)
          ).length;

          if (plexMatchCount >= 4) {
            return true;
          }
        }

        // Need at least 4 matches in Plex library for custom lists
        return false;
      }

      // Fallback: if no library cache, just check it's a movie collection
      return targetMediaType === 'movie';
    } catch (error) {
      return false;
    }
  }

  /**
   * Determine if a TMDB collection meets quality criteria
   */
  private static isQualityTmdbCollection(
    collectionData: { parts?: unknown[] },
    maxItems: number
  ): boolean {
    if (!collectionData || !collectionData.parts) {
      return false;
    }

    // Only criterion: collection must have at least maxItems movies
    return collectionData.parts.length >= maxItems;
  }
}

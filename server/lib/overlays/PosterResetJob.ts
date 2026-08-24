import type { PlexLibraryItem } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { getRecognizedPosterOwnershipMarker } from './posterOwnershipMetadata';

interface ResetStatus {
  running: boolean;
  cancelled: boolean;
  currentLibrary: string;
  currentLibraryName: string;
  current: number;
  total: number;
  failed: number;
}

/**
 * Job for resetting posters in a library to their base (overlay-free) versions
 */
class PosterResetJob {
  public running = false;
  private cancelled = false;

  // Progress tracking
  private currentLibrary = '';
  private currentLibraryName = '';
  private current = 0;
  private total = 0;
  private failed = 0;

  public get status(): ResetStatus {
    return {
      running: this.running,
      cancelled: this.cancelled,
      currentLibrary: this.currentLibrary,
      currentLibraryName: this.currentLibraryName,
      current: this.current,
      total: this.total,
      failed: this.failed,
    };
  }

  public cancel(): void {
    this.cancelled = true;
    logger.info('Poster reset job cancellation requested', {
      label: 'PosterReset',
    });
  }

  /**
   * Reset all posters in a library to their base versions (no overlays)
   */
  public async resetLibraryPosters(libraryId: string): Promise<void> {
    if (this.running) {
      logger.warn('Poster reset job is already running', {
        label: 'PosterReset',
      });
      throw new Error('Poster reset job already running');
    }

    // Safety check: don't run if overlay application is in progress
    const { default: overlayApplication } = await import(
      '@server/lib/overlayApplication'
    );
    if (overlayApplication.running) {
      throw new Error(
        'Cannot reset posters while overlay application is running'
      );
    }

    this.running = true;
    this.cancelled = false;
    this.current = 0;
    this.total = 0;
    this.failed = 0;

    try {
      logger.info('Starting poster reset job', {
        label: 'PosterReset',
        libraryId,
      });

      // Get admin user for Plex API
      const { getAdminUser } = await import(
        '@server/lib/collections/core/CollectionUtilities'
      );
      const admin = await getAdminUser();

      if (!admin) {
        throw new Error('No admin user found');
      }

      const plexApi = new PlexAPI({ plexToken: admin.plexToken });

      // Get library info
      const libraries = await plexApi.getLibraries();
      const library = libraries.find((lib) => lib.key === libraryId);

      if (!library) {
        throw new Error(`Library ${libraryId} not found`);
      }

      this.currentLibrary = libraryId;
      this.currentLibraryName = library.title;

      logger.info('Processing library for poster reset', {
        label: 'PosterReset',
        libraryId,
        libraryName: library.title,
      });

      // Fetch all items (handle pagination)
      let allItems: PlexLibraryItem[] = [];
      let offset = 0;
      const pageSize = 50;
      let hasMore = true;

      // Paginate through all library items
      while (hasMore) {
        if (this.cancelled) {
          logger.info('Poster reset cancelled during pagination', {
            label: 'PosterReset',
          });
          return;
        }

        const response = await plexApi.getLibraryContents(libraryId, {
          offset,
          size: pageSize,
        });

        allItems = allItems.concat(response.items);

        if (offset + pageSize >= response.totalSize) {
          hasMore = false;
        }

        offset += pageSize;
      }

      // Child items are not returned by the root library listing. Include only
      // season/episode rows that Agregarr has actually overlaid, so Reset
      // Posters also restores artwork created by Posterizarr follow-ups.
      const metadataService = (
        await import('@server/lib/metadata/MetadataTrackingService')
      ).default;
      const childRows = await metadataService.getOverlaidChildMetadata(
        libraryId
      );
      const existingKeys = new Set(allItems.map((item) => item.ratingKey));
      for (const row of childRows) {
        if (existingKeys.has(row.plexItemRatingKey)) continue;
        try {
          const child = await plexApi.getMetadata(row.plexItemRatingKey);
          if (child.type !== 'season' && child.type !== 'episode') continue;
          allItems.push({
            ratingKey: child.ratingKey,
            parentRatingKey: child.parentRatingKey,
            grandparentRatingKey: child.grandparentRatingKey,
            title: child.title,
            guid: child.guid || '',
            Guid: child.Guid,
            Media: child.Media,
            Label: child.Label,
            type: child.type,
            index: child.index,
            parentIndex: child.parentIndex,
            userRating: child.userRating,
            addedAt: child.addedAt || 0,
            updatedAt: child.updatedAt || 0,
          });
          existingKeys.add(child.ratingKey);
        } catch (error) {
          logger.warn('Tracked child artwork no longer exists in Plex', {
            label: 'PosterReset',
            ratingKey: row.plexItemRatingKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      this.total = allItems.length;

      logger.info('Found items to reset', {
        label: 'PosterReset',
        libraryId,
        itemCount: allItems.length,
      });

      // Get poster source preference (global setting)
      const settings = getSettings();
      const posterSource = settings.overlays?.defaultPosterSource || 'tmdb';

      // Get library type
      const libraryType: 'movie' | 'show' =
        library.type === 'movie' ? 'movie' : 'show';

      // Process each item
      for (const item of allItems) {
        if (this.cancelled) {
          logger.info('Poster reset cancelled during processing', {
            label: 'PosterReset',
            libraryId,
            processed: this.current,
            total: this.total,
          });
          break;
        }

        try {
          await this.resetItemPoster(
            plexApi,
            item,
            libraryId,
            this.currentLibraryName || library.title,
            libraryType,
            posterSource
          );
          this.current++;
        } catch (error) {
          this.failed++;
          this.current++;
          logger.error('Failed to reset poster for item', {
            label: 'PosterReset',
            itemTitle: item.title,
            ratingKey: item.ratingKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      logger.info('Completed poster reset job', {
        label: 'PosterReset',
        libraryId,
        successCount: this.current - this.failed,
        failedCount: this.failed,
        totalCount: this.total,
      });
    } catch (error) {
      logger.error('Poster reset job failed', {
        label: 'PosterReset',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.running = false;
      this.cancelled = false;
    }
  }

  /**
   * Reset a single item's poster to its base version
   */
  private async resetItemPoster(
    plexApi: PlexAPI,
    item: PlexLibraryItem,
    libraryId: string,
    libraryName: string,
    libraryType: 'movie' | 'show',
    posterSource: 'tmdb' | 'plex' | 'local'
  ): Promise<void> {
    try {
      // Get base poster based on poster source
      const { plexBasePosterManager } = await import(
        '@server/lib/overlays/PlexBasePosterManager'
      );

      const isChild = item.type === 'season' || item.type === 'episode';
      const effectivePosterSource = isChild ? 'plex' : posterSource;

      // Fetch full metadata if needed
      const fullMetadata = await plexApi.getMetadata(item.ratingKey);
      const itemWithFullMetadata = {
        ...item,
        Media: fullMetadata.Media,
        Guid: fullMetadata.Guid,
      };

      // Get metadata tracking for this item
      const metadataService = (
        await import('@server/lib/metadata/MetadataTrackingService')
      ).default;
      const metadata = await metadataService.getItemMetadata(item.ratingKey);

      // Extract TMDB ID from item GUIDs
      let tmdbId: number | undefined;
      if (
        itemWithFullMetadata.Guid &&
        Array.isArray(itemWithFullMetadata.Guid)
      ) {
        const tmdbGuid = itemWithFullMetadata.Guid.find((g) =>
          g.id?.includes('tmdb://')
        );
        if (tmdbGuid) {
          const match = tmdbGuid.id.match(/tmdb:\/\/(\d+)/);
          if (match) {
            tmdbId = parseInt(match[1]);
          }
        }
      }

      // Get base poster without applying overlays
      const basePosterResult =
        await plexBasePosterManager.getBasePosterForOverlay(
          plexApi,
          itemWithFullMetadata,
          libraryId,
          libraryName,
          libraryType,
          effectivePosterSource,
          {
            basePosterSource: metadata?.basePosterSource,
            originalPlexPosterUrl: metadata?.originalPlexPosterUrl,
            ourOverlayPosterUrl: metadata?.ourOverlayPosterUrl,
            basePosterFilename: metadata?.basePosterFilename,
            localPosterModifiedTime: metadata?.localPosterModifiedTime,
          },
          tmdbId
        );

      // Root posters keep Agregarr's historical 2:3 reset dimensions. Child
      // artwork preserves its native geometry (especially 16:9 title cards).
      const sourceOwnershipMarker = getRecognizedPosterOwnershipMarker(
        basePosterResult.posterBuffer
      );
      let posterPipeline = sharp(basePosterResult.posterBuffer);
      if (!isChild) {
        posterPipeline = posterPipeline.resize(1000, 1500, {
          fit: 'cover',
          position: 'center',
        });
      }

      // Sharp drops Posterizarr's JPEG comment. Translate a recognized source
      // marker into early JPEG EXIF, but do not mark an unowned base poster.
      posterPipeline = sourceOwnershipMarker
        ? posterPipeline.withExifMerge({
            IFD0: {
              ImageDescription: `${sourceOwnershipMarker}; preserved by Agregarr`,
            },
          })
        : posterPipeline.keepExif();

      const posterBuffer = await posterPipeline
        .jpeg({ quality: 90 })
        .toBuffer();

      // Save to temporary file
      const tempDir = os.tmpdir();
      const tempFilePath = path.join(
        tempDir,
        `reset-${item.ratingKey}-${Date.now()}.jpg`
      );

      await fs.writeFile(tempFilePath, posterBuffer);

      try {
        // Upload base poster back to Plex
        await plexApi.uploadPosterFromFile(item.ratingKey, tempFilePath);

        // Update metadata tracking
        const newPosterUrl = await plexApi.getCurrentPosterUrl(item.ratingKey);

        if (newPosterUrl) {
          // Clear overlay hash since we're resetting to base poster
          await metadataService.recordOverlayApplicationWithBasePoster(
            item.ratingKey,
            libraryId,
            '', // Empty hash since no overlays applied
            newPosterUrl,
            {
              basePosterSource: effectivePosterSource,
              originalPlexPosterUrl: basePosterResult.sourceUrl,
              basePosterFilename: basePosterResult.filename,
            },
            item.type
          );
        }

        // Remove "Overlay" label since we're resetting to base poster
        try {
          await plexApi.removeLabelFromItem(item.ratingKey, 'Overlay');
        } catch (error) {
          // Ignore label removal errors
        }

        logger.debug('Reset poster for item', {
          label: 'PosterReset',
          itemTitle: item.title,
          ratingKey: item.ratingKey,
          posterSource: effectivePosterSource,
        });
      } finally {
        // Clean up temp file
        await fs.unlink(tempFilePath).catch(() => {
          // Ignore cleanup errors
        });
      }
    } catch (error) {
      logger.error('Failed to reset item poster', {
        label: 'PosterReset',
        itemTitle: item.title,
        ratingKey: item.ratingKey,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

export const posterResetJob = new PosterResetJob();

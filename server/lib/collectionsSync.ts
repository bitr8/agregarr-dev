import PlexAPI from '@server/api/plexapi';
import collectionSyncProgress from '@server/lib/collections/CollectionSyncProgress';
import { extractErrorMessage } from '@server/lib/collections/core/CollectionUtilities';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { CollectionCleanupService } from './collections/services/CollectionCleanupService';
import { collectionSyncService } from './collections/services/CollectionSyncService';

// MAIN COLLECTIONS SYNC SERVICE

class CollectionsSync {
  public running = false;
  // Set while waiting for other jobs to finish, before real work begins.
  // Kept separate from `running` so the cross-job wait loops never see a
  // merely-queued sync as active (that would deadlock with Overlay Application).
  public pending = false;
  private cancelled = false;
  private cleanupService = new CollectionCleanupService();

  // Progress tracking
  private currentStage = '';
  private totalCollections = 0;
  private processedCollections = 0;

  public get status() {
    return {
      running: this.running,
      pending: this.pending,
      cancelled: this.cancelled,
      currentStage: this.currentStage,
      totalCollections: this.totalCollections,
      processedCollections: this.processedCollections,
      progress:
        this.totalCollections > 0
          ? Math.round(
              (this.processedCollections / this.totalCollections) * 100
            )
          : 0,
    };
  }

  public setStage(stage: string, total = 0, processed = 0): void {
    this.currentStage = stage;
    this.totalCollections = total;
    this.processedCollections = processed;
    logger.debug(
      `Sync stage: ${stage}${total > 0 ? ` (${processed}/${total})` : ''}`,
      {
        label: 'Collections Sync',
        stage,
        total,
        processed,
      }
    );
  }

  public cancel(): void {
    this.cancelled = true;
    collectionSyncService.cancel();
  }

  /**
   * Initialize a Plex client with admin token and current settings
   * Uses local admin user for Plex token (direct Plex integration)
   * @returns PlexAPI instance configured with admin token
   * @throws Error if admin user or token not found
   */
  private async getPlexClient(): Promise<PlexAPI> {
    // Get Plex token from LOCAL admin user (not external Overseerr)
    const { getAdminUser } = await import(
      '@server/lib/collections/core/CollectionUtilities'
    );
    const localAdmin = await getAdminUser();

    if (!localAdmin?.plexToken) {
      throw new Error('No local admin Plex token found');
    }

    const settings = getSettings().load();
    return new PlexAPI({
      plexToken: localAdmin.plexToken,
      plexSettings: settings.plex,
    });
  }

  /**
   * Refresh external service data for template variables
   * Updates admin Plex info and external Overseerr settings
   */
  private async refreshExternalData(plexClient: PlexAPI): Promise<void> {
    const settings = getSettings();

    try {
      // Refresh admin Plex user info if we have an admin
      const { getAdminUser } = await import(
        '@server/lib/collections/core/CollectionUtilities'
      );
      const localAdmin = await getAdminUser();

      if (localAdmin?.plexId && localAdmin.plexToken) {
        try {
          const plexTitle = await plexClient.getPlexUserTitle(
            localAdmin.plexId.toString()
          );
          if (plexTitle) {
            settings.updateAdminPlexInfo(
              localAdmin.plexUsername || undefined,
              plexTitle
            );
            logger.debug('Refreshed admin Plex info for template variables', {
              label: 'Collections Sync',
              username: localAdmin.plexUsername,
              title: plexTitle,
            });
          }
        } catch (error) {
          logger.warn('Failed to refresh admin Plex user info', {
            label: 'Collections Sync',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Refresh external Overseerr settings if configured
      if (settings.overseerr?.hostname && settings.overseerr?.apiKey) {
        try {
          const { overseerrCollectionService } = await import(
            '@server/lib/collections/sources/overseerr'
          );
          const overseerrSettings =
            await overseerrCollectionService.getOverseerrSettings();

          if (overseerrSettings) {
            settings.updateExternalOverseerrInfo(
              overseerrSettings.applicationUrl,
              overseerrSettings.applicationTitle
            );
            logger.debug(
              'Refreshed external Overseerr settings for template variables',
              {
                label: 'Collections Sync',
                applicationTitle: overseerrSettings.applicationTitle,
                applicationUrl: overseerrSettings.applicationUrl,
              }
            );
          }
        } catch (error) {
          logger.warn('Failed to refresh external Overseerr settings', {
            label: 'Collections Sync',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      logger.warn('Failed to refresh external data for template variables', {
        label: 'Collections Sync',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public async run(): Promise<void> {
    // Mark pending (not running) so the UI shows the waiting state without the
    // cross-job wait loops below treating this sync as active. `running` is set
    // only once all the waits clear (see below) to avoid a mutual deadlock with
    // Overlay Application, which waits on collectionsSync.status.running.
    this.pending = true;
    this.cancelled = false;

    // Check if discovery is running to prevent race conditions
    const { discoveryService } = await import(
      '@server/lib/collections/services/DiscoveryService'
    );
    if (discoveryService.status.running) {
      this.pending = false;
      throw new Error(
        'Discovery is currently running. Please wait for discovery to complete before starting sync.'
      );
    }

    // Check if randomize home order is running to prevent conflicts
    const randomizeHomeOrder = (await import('@server/lib/randomizeHomeOrder'))
      .default;
    if (randomizeHomeOrder.status.running) {
      logger.info(
        'Randomize Home Order is currently running, waiting for completion...',
        {
          label: 'Collections Sync',
        }
      );
      while (randomizeHomeOrder.status.running && !this.cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    if (this.cancelled) {
      this.pending = false;
      return;
    }

    // Wait for Collections Quick Sync to complete if running
    const collectionsQuickSync = (
      await import('@server/lib/collectionsQuickSync')
    ).default;
    if (collectionsQuickSync.status.running) {
      logger.info(
        'Collections Quick Sync is currently running, waiting for completion...',
        {
          label: 'Collections Sync',
        }
      );
      while (collectionsQuickSync.status.running && !this.cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    if (this.cancelled) {
      this.pending = false;
      return;
    }

    // Wait for Overlay Application to complete if running
    const overlayApplication = (await import('@server/lib/overlayApplication'))
      .default;
    if (overlayApplication.status.running) {
      logger.info(
        'Overlay Application is currently running, waiting for completion...',
        {
          label: 'Collections Sync',
        }
      );
      while (overlayApplication.status.running && !this.cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!this.cancelled) {
        logger.info(
          'Overlay Application completed, starting Collections Sync',
          {
            label: 'Collections Sync',
          }
        );
      }
    }

    if (this.cancelled) {
      this.pending = false;
      return;
    }

    // Wait for any running individual collection syncs to complete
    const { IndividualCollectionScheduler } = await import(
      '@server/lib/collections/services/IndividualCollectionScheduler'
    );

    const anyIndividualSyncsRunning =
      IndividualCollectionScheduler.getLibraryQueuesStatus().some(
        (queue) => queue.running || queue.queueSize > 0
      );

    if (anyIndividualSyncsRunning) {
      logger.info(
        'Individual collection syncs are running, waiting for completion...',
        {
          label: 'Collections Sync',
          runningQueues: IndividualCollectionScheduler.getLibraryQueuesStatus()
            .filter((q) => q.running || q.queueSize > 0)
            .map((q) => ({
              libraryId: q.libraryId,
              queueSize: q.queueSize,
              running: q.running,
            })),
        }
      );

      await IndividualCollectionScheduler.waitForIndividualSyncsToComplete();
    }

    if (this.cancelled) {
      this.pending = false;
      return;
    }

    // All cross-job waits have cleared: claim the running state now. Setting it
    // here (rather than at the top of run()) is what prevents the deadlock with
    // Overlay Application while still gating individual syncs during real work.
    this.running = true;
    this.pending = false;
    IndividualCollectionScheduler.setFullSyncRunning(true);
    this.setStage('Starting sync...');

    const settings = getSettings();
    const startTime = Date.now();

    // Everything past the running claim runs inside try/finally so that an
    // early return from the pre-flight validation below still releases the
    // running / pending / full-sync flags (the finally block resets them).
    try {
      // Initialize rich progress tracking (populated with total count later)
      collectionSyncProgress.startSync(0);
      collectionSyncProgress.setDetail('Starting sync...');

      // Validate Plex configuration
      if (!settings.plex.ip || !settings.plex.machineId) {
        logger.error(
          'Plex server configuration incomplete. Please check Plex settings.',
          { label: 'Collections Sync' }
        );
        collectionSyncProgress.fail('Plex server configuration incomplete');
        return;
      }

      // Get admin user for Plex token
      // Check local admin user for Plex token (not external Overseerr)
      const { getAdminUser } = await import(
        '@server/lib/collections/core/CollectionUtilities'
      );
      const localAdmin = await getAdminUser();

      if (!localAdmin?.plexToken) {
        logger.warn(
          'Collections sync skipped. No local admin Plex token found.',
          {
            label: 'Collections Sync',
          }
        );
        collectionSyncProgress.fail('No local admin Plex token found');
        return;
      }

      // Initialize Plex client
      this.setStage('Connecting to Plex server...');
      collectionSyncProgress.setDetail('Connecting to Plex server...');
      const plexClient = await this.getPlexClient();

      // Test connection
      const isConnected = await plexClient.getStatus();
      if (!isConnected) {
        throw new Error('Could not connect to Plex server');
      }

      // Refresh external service data for template variables
      this.setStage('Refreshing external data...');
      collectionSyncProgress.setDetail('Refreshing external data...');
      await this.refreshExternalData(plexClient);

      // Transition to processing phase — total set by syncAllConfigurations
      collectionSyncProgress.setPhase('processing');

      // Perform the sync operations using our new service
      const syncResult = await collectionSyncService.syncAllConfigurations(
        plexClient,
        (processed: number, currentAction?: string, total?: number) => {
          const t = total ?? 0;
          if (currentAction) {
            this.setStage(currentAction, t, processed);
            collectionSyncProgress.setDetail(currentAction);
          } else {
            this.setStage('Processing collections...', t, processed);
          }
        }
      );

      // Transition to cleanup phase
      collectionSyncProgress.setPhase('cleanup');

      // Sync hub visibility settings
      this.setStage('Syncing hub visibility settings...');
      collectionSyncProgress.setDetail('Syncing hub visibility settings...');
      const { HubSyncService } = await import(
        './collections/plex/HubSyncService'
      );
      const hubSyncService = new HubSyncService();
      const hubSyncPhaseStart = Date.now();
      await hubSyncService.syncHubVisibility(plexClient, (stage: string) => {
        this.setStage(stage);
      });
      plexClient.recordPhaseTime('hubSync', Date.now() - hubSyncPhaseStart);

      // Sync pre-existing collection sortTitles based on promotion status
      this.setStage('Updating collection sort titles...');
      collectionSyncProgress.setDetail('Updating collection sort titles...');
      const orderingPhaseStart = Date.now();
      await hubSyncService.syncPreExistingCollectionSortTitles(plexClient);

      // Sync unified ordering (collections + hubs)
      this.setStage('Applying collection ordering to Plex...');
      collectionSyncProgress.setDetail(
        'Applying collection ordering to Plex...'
      );
      await hubSyncService.syncUnifiedOrdering(plexClient, (stage: string) => {
        this.setStage(stage);
      });
      plexClient.recordPhaseTime('ordering', Date.now() - orderingPhaseStart);

      // Clean up orphaned collections after sync completes
      this.setStage('Cleaning up orphaned collections...');
      collectionSyncProgress.setDetail('Cleaning up orphaned collections...');
      logger.info('Starting post-sync cleanup of orphaned collections', {
        label: 'Collections Sync',
      });

      try {
        const settings = getSettings();
        const collectionConfigs = settings.plex.collectionConfigs || [];

        // Get all collections to find agregarr-managed ones
        const allCollections = await plexClient.getAllCollections();
        const agregarrCollections = allCollections.filter(
          (collection) =>
            Array.isArray(collection.labels) &&
            collection.labels.some((label) => {
              const labelText =
                typeof label === 'string'
                  ? label
                  : (label as { tag: string }).tag;
              return labelText.toLowerCase().startsWith('agregarr');
            })
        );

        if (agregarrCollections.length > 0) {
          const cleanupResult =
            await this.cleanupService.cleanupDisabledCollections(
              plexClient,
              agregarrCollections,
              collectionConfigs,
              {}, // userCollections - handled internally by cleanup logic
              syncResult.processedCollectionKeys // Pass the collections that were just processed
            );

          if (cleanupResult.deleted > 0) {
            logger.info(
              `Post-sync cleanup completed: ${cleanupResult.deleted} orphaned collections removed`,
              {
                label: 'Collections Sync',
              }
            );
          } else {
            logger.debug(
              'Post-sync cleanup completed: no orphaned collections found',
              {
                label: 'Collections Sync',
              }
            );
          }
        }
      } catch (error) {
        logger.warn(
          'Post-sync cleanup failed - continuing with sync completion',
          {
            label: 'Collections Sync',
            error: error instanceof Error ? error.message : String(error),
          }
        );
      }

      // Clean up orphaned placeholder records and files
      this.setStage('Cleaning up orphaned placeholders...');
      collectionSyncProgress.setDetail('Cleaning up orphaned placeholders...');
      let cleanupResult: {
        filesRemoved: number;
        deletedPaths: {
          fullPath: string;
          relativePath: string;
          libraryKey: string;
          mediaType: 'movie' | 'tv';
          plexRatingKey?: string;
        }[];
      } = { filesRemoved: 0, deletedPaths: [] };

      try {
        const {
          cleanupOrphanedPlaceholderRecords,
          cleanupOrphanedPlaceholderFiles,
          backfillAllTrackedPlaceholderMarkers,
        } = await import(
          '@server/lib/placeholders/services/PlaceholderCleanup'
        );

        // Step 1: Remove orphaned DB records (where collection no longer exists)
        await cleanupOrphanedPlaceholderRecords();

        // Step 2: Remove orphaned files (where no DB records reference them)
        cleanupResult = await cleanupOrphanedPlaceholderFiles(plexClient);

        logger.info('Orphaned placeholder cleanup completed', {
          label: 'Collections Sync',
          filesRemoved: cleanupResult.filesRemoved,
        });

        // Step 3: Back-fill markers for ALL tracked placeholders missing them.
        // The orphan-adoption scan that also back-fills only reaches a library's
        // first page (getLibraryContents default size), so most legacy
        // placeholders never converge onto markers. This DB-record-driven pass
        // covers every tracked placeholder. Additive and independent of the
        // deletion paths above: it writes only absent markers and changes no
        // deletion decision this sync (its markers are read by the next sync).
        await backfillAllTrackedPlaceholderMarkers();
      } catch (error) {
        logger.warn('Orphaned placeholder cleanup failed - continuing', {
          label: 'Collections Sync',
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Remove stale Plex entries for deleted placeholder files
      if (cleanupResult.deletedPaths.length > 0) {
        this.setStage(
          'Removing stale Plex entries for deleted placeholders...'
        );
        collectionSyncProgress.setDetail('Removing stale Plex entries...');

        const { cleanupStalePlexEntries } = await import(
          '@server/lib/placeholders/services/PlaceholderCleanup'
        );
        await cleanupStalePlexEntries(plexClient, cleanupResult.deletedPaths);
      }

      const duration = Date.now() - startTime;

      // Run discovery to refresh missing warnings
      this.setStage('Refreshing collection status...');
      collectionSyncProgress.setDetail('Refreshing collection status...');
      try {
        const { discoveryService } = await import(
          '@server/lib/collections/services/DiscoveryService'
        );
        await discoveryService.discoverAllHubs(
          plexClient,
          true, // Update settings with any new discoveries to keep everything in sync
          true // Skip sync check since we're already in sync
        );
        logger.info('Collection status refreshed successfully', {
          label: 'Collections Sync',
        });
      } catch (error) {
        logger.warn('Failed to refresh collection status after sync', {
          label: 'Collections Sync',
          error: error instanceof Error ? error.message : String(error),
        });
        // Don't fail the sync if discovery fails
      }

      // Randomize home order for collections with randomizeHomeOrder enabled
      try {
        this.setStage('Randomizing home order...');
        collectionSyncProgress.setDetail('Randomizing home order...');
        const randomizeHomeOrder = (
          await import('@server/lib/randomizeHomeOrder')
        ).default;
        await randomizeHomeOrder.run();
      } catch (error) {
        logger.warn('Failed to randomize home order', {
          label: 'Collections Sync',
          error: error instanceof Error ? error.message : String(error),
        });
        // Don't fail the sync if randomization fails
      }

      const writeSummary = plexClient.getWriteSummary();
      logger.info(
        `Plex writes this sync: ${writeSummary.total} (${writeSummary.text})`,
        { label: 'Collections Sync' }
      );
      logger.info(`Sync phase timings: ${plexClient.getPhaseSummary()}`, {
        label: 'Collections Sync',
      });

      logger.info('Collections sync completed successfully', {
        label: 'Collections Sync',
        duration: `${Math.round(duration / 1000)}s`,
        durationMs: duration,
      });

      if (this.cancelled) {
        this.setStage('Sync cancelled');
        collectionSyncProgress.cancel();
      } else {
        this.setStage('Sync completed successfully');
        settings.setGlobalSyncComplete();
        collectionSyncProgress.complete();
      }
    } catch (error) {
      const errorMessage = extractErrorMessage(error);
      logger.error(`Collections sync failed: ${errorMessage}.`, {
        label: 'Collections Sync',
      });

      // Mark global sync error
      settings.setGlobalSyncError(errorMessage);
      collectionSyncProgress.fail(errorMessage);
    } finally {
      this.running = false;
      this.pending = false;
      this.cancelled = false;

      // Allow individual syncs to resume
      const { IndividualCollectionScheduler } = await import(
        '@server/lib/collections/services/IndividualCollectionScheduler'
      );
      IndividualCollectionScheduler.setFullSyncRunning(false);

      // Process any individual syncs that were queued during main sync
      try {
        await IndividualCollectionScheduler.processPendingQueues();
      } catch (error) {
        logger.warn(
          'Failed to process pending individual collection syncs after main sync',
          {
            label: 'Collections Sync',
            error: error instanceof Error ? error.message : String(error),
          }
        );
      }

      // Reset progress tracking
      this.currentStage = '';
      this.totalCollections = 0;
      this.processedCollections = 0;
    }
  }

  /**
   * Remove collections for items that are no longer requested
   * Delegates to CollectionCleanupService
   */
  public async cleanupCollections(): Promise<void> {
    const plexClient = await this.getPlexClient();
    await this.cleanupService.cleanupCollections(plexClient);
  }

  /**
   * Combined purge operation - removes all collections and user labels
   * Delegates to CollectionCleanupService
   */
  public async purgeAllData(): Promise<{
    collectionsDeleted: number;
    usersProcessed: number;
    labelsSuccessful: number;
    labelsFailed: number;
  }> {
    const plexClient = await this.getPlexClient();
    return await this.cleanupService.purgeAllData(plexClient);
  }
}

// Create single instance and export it
const collectionsSync = new CollectionsSync();
export default collectionsSync;

import { getRepository } from '@server/datasource';
import { OverlayLibraryConfig } from '@server/entity/OverlayLibraryConfig';
import logger from '@server/logger';

/**
 * Job for applying overlay templates to configured Plex libraries
 */
class OverlayApplication {
  public running = false;
  // Set while waiting for other jobs to finish, before real work begins.
  // Kept separate from `running` so the cross-job wait loops never see a
  // merely-queued job as active (that would deadlock with Collections Sync).
  public pending = false;
  private cancelled = false;

  // Progress tracking
  private currentStage = '';
  private totalLibraries = 0;
  private processedLibraries = 0;

  public get status() {
    return {
      running: this.running,
      pending: this.pending,
      cancelled: this.cancelled,
      currentStage: this.currentStage,
      totalLibraries: this.totalLibraries,
      processedLibraries: this.processedLibraries,
      progress:
        this.totalLibraries > 0
          ? Math.round((this.processedLibraries / this.totalLibraries) * 100)
          : 0,
    };
  }

  private setStage(stage: string): void {
    this.currentStage = stage;
    logger.info(stage, { label: 'Overlay Application' });
  }

  private updateProgress(processed: number, total: number): void {
    this.processedLibraries = processed;
    this.totalLibraries = total;
    logger.info(
      `Overlay application progress: ${processed}/${total} libraries`,
      {
        label: 'Overlay Application',
        processed,
        total,
        progress: Math.round((processed / total) * 100),
      }
    );
  }

  public cancel(): void {
    this.cancelled = true;
    logger.info('Overlay application cancellation requested', {
      label: 'Overlay Application',
    });
  }

  public async run(): Promise<void> {
    if (this.running || this.pending) {
      logger.warn('Overlay application is already running', {
        label: 'Overlay Application',
      });
      return;
    }

    // Mark pending (not running) so the UI shows the waiting state without the
    // cross-job wait loops below treating this job as active. `running` is set
    // only once all the waits clear (see below) to avoid a mutual deadlock with
    // Collections Sync, which waits on overlayApplication.status.running.
    this.pending = true;
    this.cancelled = false;

    // Safety check: don't run if base poster download is in progress
    const { plexBasePosterDownloadJob } = await import(
      '@server/lib/overlays/PlexBasePosterDownloadJob'
    );
    if (plexBasePosterDownloadJob.running) {
      this.pending = false;
      throw new Error(
        'Cannot run overlay application while base posters are being downloaded. ' +
          'Please wait for the download to complete.'
      );
    }

    // Wait for Overlays Quick Sync to complete if running
    const overlaysQuickSync = (await import('@server/lib/overlaysQuickSync'))
      .default;
    if (overlaysQuickSync.status.running) {
      logger.info(
        'Overlays Quick Sync is currently running, waiting for completion...',
        {
          label: 'Overlay Application',
        }
      );
      while (overlaysQuickSync.status.running && !this.cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    if (this.cancelled) {
      this.pending = false;
      return;
    }

    // Wait for Collections Sync to complete if running
    const collectionsSync = (await import('@server/lib/collectionsSync'))
      .default;
    if (collectionsSync.status.running) {
      logger.info(
        'Collections Sync is currently running, waiting for completion...',
        {
          label: 'Overlay Application',
        }
      );
      while (collectionsSync.status.running && !this.cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!this.cancelled) {
        logger.info(
          'Collections Sync completed, starting Overlay Application',
          {
            label: 'Overlay Application',
          }
        );
      }
    }

    if (this.cancelled) {
      this.pending = false;
      return;
    }

    // Wait for any per-library overlay syncs to complete
    const { overlayLibraryService } = await import(
      '@server/lib/overlays/OverlayLibraryService'
    );
    let runningLibraries = overlayLibraryService.getAllRunningLibraries();
    if (runningLibraries.length > 0) {
      logger.info(
        'Per-library overlay syncs are currently running, waiting for completion...',
        {
          label: 'Overlay Application',
          runningLibraries: runningLibraries.map((l) => l.libraryName),
        }
      );
      while (runningLibraries.length > 0 && !this.cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        runningLibraries = overlayLibraryService.getAllRunningLibraries();
      }
      if (!this.cancelled) {
        logger.info('Per-library overlay syncs completed, starting full sync', {
          label: 'Overlay Application',
        });
      }
    }

    if (this.cancelled) {
      this.pending = false;
      return;
    }

    // All cross-job waits have cleared: claim the running state now. Setting it
    // here (rather than at the top of run()) is what prevents the deadlock with
    // Collections Sync while still gating dependent jobs during real work.
    this.running = true;
    this.pending = false;
    this.currentStage = '';
    this.totalLibraries = 0;
    this.processedLibraries = 0;

    try {
      logger.info('Starting overlay application job', {
        label: 'Overlay Application',
      });

      this.setStage('Loading library configurations...');

      // Get all library configurations with enabled overlays
      const configRepository = getRepository(OverlayLibraryConfig);
      const configs = await configRepository.find();

      // Filter to only configs that have enabled overlays
      const activeConfigs = configs.filter(
        (config) =>
          config.enabledOverlays &&
          config.enabledOverlays.some((o) => o.enabled)
      );

      // A library whose config was deleted, or whose overlays were all switched
      // off, drops out of activeConfigs and would never be visited again - so the
      // season countdown posters it still carries would stay on Plex forever.
      // Visiting it lets processLibraryOverlays reach its config-driven cleanup.
      const metadataService = (
        await import('@server/lib/metadata/MetadataTrackingService')
      ).default;
      const activeLibraryIds = new Set(activeConfigs.map((c) => c.libraryId));
      const seasonCleanupOnlyIds = (
        await metadataService.getLibraryKeysWithSeasonOverlays()
      ).filter((libraryId) => !activeLibraryIds.has(libraryId));

      if (seasonCleanupOnlyIds.length > 0) {
        logger.info(
          'Sweeping libraries that only need season overlay cleanup',
          {
            label: 'Overlay Application',
            libraryIds: seasonCleanupOnlyIds,
          }
        );
      }

      const targets = [
        ...activeConfigs.map((config) => ({
          libraryId: config.libraryId,
          libraryName: config.libraryName,
        })),
        ...seasonCleanupOnlyIds.map((libraryId) => ({
          libraryId,
          libraryName: libraryId,
        })),
      ];

      if (targets.length === 0) {
        logger.info('No libraries with enabled overlays found', {
          label: 'Overlay Application',
        });
        return;
      }

      this.totalLibraries = targets.length;
      logger.info('Found libraries with overlays configured', {
        label: 'Overlay Application',
        libraryCount: activeConfigs.length,
        seasonCleanupOnlyCount: seasonCleanupOnlyIds.length,
      });

      // Process each library
      let processed = 0;

      for (const config of targets) {
        if (this.cancelled) {
          logger.info('Overlay application cancelled by user', {
            label: 'Overlay Application',
          });
          break;
        }

        try {
          this.setStage(
            `Applying overlays to library: ${config.libraryName}...`
          );

          await overlayLibraryService.applyOverlaysToLibrary(
            config.libraryId,
            () => this.cancelled
          );

          processed++;
          this.updateProgress(processed, this.totalLibraries);
        } catch (error) {
          logger.error('Failed to apply overlays to library', {
            label: 'Overlay Application',
            libraryId: config.libraryId,
            libraryName: config.libraryName,
            error: error instanceof Error ? error.message : String(error),
          });
          // Continue with next library even if one fails
          processed++;
          this.updateProgress(processed, this.totalLibraries);
        }
      }

      if (this.cancelled) {
        logger.info('Overlay application job cancelled', {
          label: 'Overlay Application',
          processedLibraries: processed,
          totalLibraries: this.totalLibraries,
        });
      } else {
        logger.info('Overlay application job completed', {
          label: 'Overlay Application',
          processedLibraries: processed,
          totalLibraries: this.totalLibraries,
        });
      }
    } catch (error) {
      logger.error('Overlay application job failed', {
        label: 'Overlay Application',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.running = false;
      this.pending = false;
      this.cancelled = false;
      this.currentStage = '';
    }
  }
}

const overlayApplication = new OverlayApplication();
export default overlayApplication;

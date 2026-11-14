import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

class RotationApply {
  public status: { running: boolean } = { running: false };

  private rerun = false;

  /** Background: syncHubVisibility + syncUnifiedOrdering, then markApplied. Skips while a sync runs. */
  public kick(): void {
    if (this.status.running) {
      this.rerun = true;
      return;
    }
    this.status.running = true;
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      do {
        this.rerun = false;
        const collectionsSync = (await import('@server/lib/collectionsSync'))
          .default;
        if (collectionsSync.running || collectionsSync.pending) return;

        const { getAdminUser } = await import(
          '@server/lib/collections/core/CollectionUtilities'
        );
        const localAdmin = await getAdminUser();
        if (!localAdmin?.plexToken) {
          throw new Error('No local admin Plex token found');
        }
        const PlexAPI = (await import('@server/api/plexapi')).default;
        const plexClient = new PlexAPI({
          plexToken: localAdmin.plexToken,
          plexSettings: getSettings().plex,
        });
        const { HubSyncService } = await import(
          '@server/lib/collections/plex/HubSyncService'
        );
        const hubSync = new HubSyncService();
        await hubSync.syncHubVisibility(plexClient);
        await hubSync.syncUnifiedOrdering(plexClient);
        const { rotationGroupService } = await import('./RotationGroupService');
        rotationGroupService.markApplied();
      } while (this.rerun);
    } catch (error) {
      logger.error('Rotation apply failed', {
        label: 'Rotation',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.status.running = false;
    }
  }
}

export const rotationApply = new RotationApply();
export default rotationApply;

import type PlexAPI from '@server/api/plexapi';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { RotationGroup, Visibility } from './types';

export interface HubRow {
  identifier: string;
  promotedToRecommended?: boolean;
  promotedToOwnHome?: boolean;
  promotedToSharedHome?: boolean;
}

const flags = (h: HubRow): Visibility => ({
  usersHome: !!h.promotedToSharedHome,
  serverOwnerHome: !!h.promotedToOwnHome,
  libraryRecommended: !!h.promotedToRecommended,
});

const same = (a: Visibility, b: Visibility): boolean =>
  a.usersHome === b.usersHome &&
  a.serverOwnerHome === b.serverOwnerHome &&
  a.libraryRecommended === b.libraryRecommended;

/** True when Plex hub management matches the group: occupants carry exactly its surfaces, waiting members none. */
export function groupAppliedInPlex(
  group: RotationGroup,
  hubs: HubRow[]
): boolean {
  const showing = new Set(group.state.slots.map((s) => s.occupant));
  for (const member of group.members) {
    if (member.unboundSince || !member.ratingKey) continue;
    const row = hubs.find(
      (h) =>
        h.identifier ===
        `custom.collection.${group.libraryId}.${member.ratingKey}`
    );
    if (showing.has(member.key)) {
      if (!row || !same(flags(row), group.surfaces)) return false;
    } else if (row && isOn(flags(row))) {
      return false;
    }
  }
  return true;
}

const isOn = (v: Visibility): boolean =>
  v.usersHome || v.serverOwnerHome || v.libraryRecommended;

/** Marks captured seqs applied, but only for enabled groups whose hub rows in Plex match. */
export async function markVerified(
  plexClient: PlexAPI,
  seqs: Record<string, number>
): Promise<void> {
  const { rotationGroupService } = await import('./RotationGroupService');
  const result = { ...seqs };
  const hubsByLibrary = new Map<string, HubRow[] | null>();
  for (const group of rotationGroupService.enabledGroups()) {
    if (!(group.id in seqs)) continue;
    if (group.state.seq !== seqs[group.id]) {
      delete result[group.id];
      continue;
    }
    if (!hubsByLibrary.has(group.libraryId)) {
      try {
        const mgmt = await plexClient.getHubManagement(group.libraryId);
        hubsByLibrary.set(
          group.libraryId,
          (mgmt?.MediaContainer?.Hub ?? []) as HubRow[]
        );
      } catch (error) {
        logger.warn('Could not read hub management to verify rotation', {
          label: 'Rotation',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        hubsByLibrary.set(group.libraryId, null);
      }
    }
    const hubs = hubsByLibrary.get(group.libraryId);
    if (!hubs || !groupAppliedInPlex(group, hubs)) delete result[group.id];
  }
  rotationGroupService.markApplied(result);
}

class RotationApply {
  public status: { running: boolean } = { running: false };

  private rerun = false;
  private libraries = new Set<string>();

  /** Sets running synchronously, then settles positions and applies to Plex in the background; overlapping kicks collapse into one rerun. */
  public kick(libraryId?: string): void {
    if (libraryId) this.libraries.add(libraryId);
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

        const { rotationGroupService } = await import('./RotationGroupService');
        const libraries = [...this.libraries];
        this.libraries.clear();
        await rotationGroupService.settlePositions(libraries);

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
        const seqs = rotationGroupService.captureSeqs();
        const hubSync = new HubSyncService();
        await hubSync.syncHubVisibility(plexClient);
        await hubSync.syncUnifiedOrdering(plexClient);
        await markVerified(plexClient, seqs);
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

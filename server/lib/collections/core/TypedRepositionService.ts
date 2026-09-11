import type {
  CollectionConfig,
  PreExistingCollectionConfig,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import {
  compactPromotedRanks,
  computeReposition,
  type RepositionPeer,
} from './CollectionUtilities';

export type RepositionTargetType = 'collection' | 'preExisting';

interface PeerUpdate {
  id: string;
  sortOrderLibrary: number;
}

/**
 * Gathers every currently-promoted config in a library, across all three
 * types, mixed together - shared by computeAndApplyTypedReposition and
 * compactAndApplyPromotedRanks below, since both need the exact same "one
 * numbering space per library" view.
 */
async function gatherLibraryConfigs(targetLibraryId: string) {
  const settings = getSettings();
  const { preExistingCollectionConfigService } = await import(
    '@server/lib/collections/services/PreExistingCollectionConfigService'
  );
  const { defaultHubConfigService } = await import(
    '@server/lib/collections/services/DefaultHubConfigService'
  );

  const collectionConfigs = settings.plex.collectionConfigs || [];
  const preExistingConfigs = preExistingCollectionConfigService.getConfigs();
  const hubConfigs = defaultHubConfigService.getConfigs();

  const resolveLibraryId = (libraryId: string | string[]) =>
    Array.isArray(libraryId) ? libraryId[0] : libraryId;

  const toPeer = (c: {
    id: string;
    libraryId: string | string[];
    sortOrderLibrary?: number;
    isLibraryPromoted?: boolean;
  }): RepositionPeer => ({
    id: c.id,
    libraryId: c.libraryId,
    sortOrderLibrary: c.sortOrderLibrary,
    isLibraryPromoted: c.isLibraryPromoted,
  });

  const inLibrary = <T extends { libraryId: string | string[] }>(list: T[]) =>
    list.filter((c) => resolveLibraryId(c.libraryId) === targetLibraryId);

  const allPeers: RepositionPeer[] = [
    ...inLibrary(collectionConfigs).map(toPeer),
    ...inLibrary(preExistingConfigs).map(toPeer),
    ...inLibrary(hubConfigs).map(toPeer),
  ];

  return {
    settings,
    preExistingCollectionConfigService,
    defaultHubConfigService,
    collectionConfigs,
    preExistingConfigs,
    hubConfigs,
    allPeers,
  };
}

/**
 * Closes any gap in the promoted rank sequence for a library, across all
 * three config types. Call this after a demote (or anything else that
 * removes one collection from the promoted set outside of a full
 * reposition) - the demoted item should already be saved as
 * isLibraryPromoted: false by the caller before this runs, so it's simply
 * absent from the "currently promoted" peer list gathered here. See
 * compactPromotedRanks for why this is needed at all.
 */
export async function compactAndApplyPromotedRanks(
  targetLibraryId: string
): Promise<void> {
  const {
    settings,
    preExistingCollectionConfigService,
    defaultHubConfigService,
    collectionConfigs,
    preExistingConfigs,
    hubConfigs,
    allPeers,
  } = await gatherLibraryConfigs(targetLibraryId);

  const updates = compactPromotedRanks(allPeers);
  if (updates.length === 0) return;

  const rankById = new Map(updates.map((u) => [u.id, u.sortOrderLibrary]));
  const applyRanks = <T extends { id: string; sortOrderLibrary?: number }>(
    list: T[]
  ): T[] =>
    list.map((c) =>
      rankById.has(c.id) ? { ...c, sortOrderLibrary: rankById.get(c.id) } : c
    );

  const touchedCollections = collectionConfigs.filter((c) =>
    rankById.has(c.id)
  );
  if (touchedCollections.length > 0) {
    settings.plex.collectionConfigs = applyRanks(
      collectionConfigs
    ) as CollectionConfig[];
    settings.save();
    for (const c of touchedCollections) {
      settings.markCollectionModified(c.id, 'collection');
    }
  }

  const touchedPreExisting = preExistingConfigs.filter((c) =>
    rankById.has(c.id)
  );
  if (touchedPreExisting.length > 0) {
    preExistingCollectionConfigService.saveExistingConfigs(
      applyRanks(preExistingConfigs) as PreExistingCollectionConfig[]
    );
    for (const c of touchedPreExisting) {
      settings.markCollectionModified(c.id, 'preExisting');
    }
  }

  const touchedHubs = hubConfigs.filter((c) => rankById.has(c.id));
  if (touchedHubs.length > 0) {
    defaultHubConfigService.saveExistingConfigs(
      applyRanks(hubConfigs) as Parameters<
        typeof defaultHubConfigService.saveExistingConfigs
      >[0]
    );
  }
}

/**
 * Applies a typed-in Sort Title reposition. Regular collections,
 * pre-existing collections, and default hubs all share one
 * sortOrderLibrary numbering space per library (see reorder.ts, which
 * already combines all three for drag-and-drop) - so a reposition
 * triggered from any one of them has to consider every promoted peer of
 * every type, or it silently collides with ranks it never knew about.
 *
 * Peer updates for the two types OTHER than `targetType` are applied and
 * saved directly here. Peer updates for the SAME type as the target are
 * returned instead of saved here, since the caller (one of the two
 * /:id/settings routes) already reads, mutates, and saves its own config
 * array once at the end of the request - saving them here too would race
 * with that and whichever happened last would silently discard the other.
 */
export async function computeAndApplyTypedReposition(
  targetId: string,
  targetType: RepositionTargetType,
  targetLibraryId: string,
  requestedRank: number
): Promise<{
  targetNewRank: number;
  sameTypePeerUpdates: PeerUpdate[];
}> {
  const {
    settings,
    preExistingCollectionConfigService,
    defaultHubConfigService,
    collectionConfigs,
    preExistingConfigs,
    hubConfigs,
    allPeers,
  } = await gatherLibraryConfigs(targetLibraryId);

  const { targetNewRank, peerUpdates } = computeReposition(
    targetId,
    targetLibraryId,
    requestedRank,
    allPeers
  );

  if (peerUpdates.length === 0) {
    return { targetNewRank, sameTypePeerUpdates: [] };
  }

  const rankById = new Map(peerUpdates.map((u) => [u.id, u.sortOrderLibrary]));
  const sameTypePeerUpdates: PeerUpdate[] = [];

  const applyRanks = <T extends { id: string; sortOrderLibrary?: number }>(
    list: T[]
  ): T[] =>
    list.map((c) =>
      rankById.has(c.id) ? { ...c, sortOrderLibrary: rankById.get(c.id) } : c
    );

  // Regular collections
  if (targetType === 'collection') {
    for (const c of collectionConfigs) {
      const rank = rankById.get(c.id);
      if (rank !== undefined) {
        sameTypePeerUpdates.push({
          id: c.id,
          sortOrderLibrary: rank,
        });
      }
    }
  } else {
    const touched = collectionConfigs.filter((c) => rankById.has(c.id));
    if (touched.length > 0) {
      settings.plex.collectionConfigs = applyRanks(
        collectionConfigs
      ) as CollectionConfig[];
      settings.save();
      for (const c of touched) {
        settings.markCollectionModified(c.id, 'collection');
      }
    }
  }

  // Pre-existing collections
  if (targetType === 'preExisting') {
    for (const c of preExistingConfigs) {
      const rank = rankById.get(c.id);
      if (rank !== undefined) {
        sameTypePeerUpdates.push({
          id: c.id,
          sortOrderLibrary: rank,
        });
      }
    }
  } else {
    const touched = preExistingConfigs.filter((c) => rankById.has(c.id));
    if (touched.length > 0) {
      preExistingCollectionConfigService.saveExistingConfigs(
        applyRanks(preExistingConfigs) as PreExistingCollectionConfig[]
      );
      for (const c of touched) {
        settings.markCollectionModified(c.id, 'preExisting');
      }
    }
  }

  // Default hubs - never the reposition target (hubs have no Sort Title
  // field), so peer updates for them are always applied and saved here.
  const touchedHubs = hubConfigs.filter((c) => rankById.has(c.id));
  if (touchedHubs.length > 0) {
    defaultHubConfigService.saveExistingConfigs(
      applyRanks(hubConfigs) as Parameters<
        typeof defaultHubConfigService.saveExistingConfigs
      >[0]
    );
  }

  return { targetNewRank, sameTypePeerUpdates };
}

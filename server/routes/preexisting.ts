import { preExistingCollectionConfigService } from '@server/lib/collections/services/PreExistingCollectionConfigService';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';

const preExistingRoutes = Router();

/**
 * GET /api/v1/preexisting
 * Get current pre-existing collection configurations
 */
preExistingRoutes.get('/', isAuthenticated(), async (req, res) => {
  try {
    const configs = preExistingCollectionConfigService.getConfigs();

    logger.debug('Fetching pre-existing collection configurations', {
      label: 'Pre-existing Collections API',
      count: configs.length,
      collectionNames: configs.map((c) => c.name).slice(0, 10),
    });

    res.status(200).json(configs);
  } catch (error) {
    logger.error('Failed to get pre-existing collection configurations', {
      label: 'Pre-existing Collections API',
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      error: 'Failed to get pre-existing collection configurations',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * PUT /api/v1/preexisting/:id/settings
 * Update individual pre-existing collection settings
 */
preExistingRoutes.put('/:id/settings', isAuthenticated(), async (req, res) => {
  const { id } = req.params;

  try {
    // Detect a typed-in reposition: the Sort Title field is pre-filled with
    // this collection's current computed value (e.g. "!001_Name"), so if
    // the user edited only the rank digits and left the name suffix
    // matching, they mean "move this to rank N" - the same intent as
    // dragging it there - not "give this a literal custom title". Mirrors
    // the identical block in collectionsRoutes' PUT /:id/settings - see
    // TypedRepositionService for why the peer search has to span regular
    // collections, pre-existing collections, and default hubs together.
    //
    // Only auto-repositions a collection that is ALREADY promoted - a pure
    // move within the promoted section, no promotion decision to make. A
    // typed "!" rank on a collection still in A-Z is deliberately NOT acted
    // on here: it's stored as a literal override so the client can ask
    // first, then replay the rank through PATCH /:id/promote's targetRank
    // if confirmed. Mirrors the identical gate in collectionsRoutes.
    if (typeof req.body.sortTitleOverride === 'string') {
      const existingConfig = preExistingCollectionConfigService
        .getConfigs()
        .find((c) => c.id === id);

      if (existingConfig?.isLibraryPromoted === true) {
        const { parseTypedRepositionRank } = await import(
          '@server/lib/collections/core/CollectionUtilities'
        );
        const parsedRank = parseTypedRepositionRank(req.body.sortTitleOverride);

        if (
          parsedRank !== undefined &&
          parsedRank !== existingConfig.sortOrderLibrary
        ) {
          const { computeAndApplyTypedReposition } = await import(
            '@server/lib/collections/core/TypedRepositionService'
          );
          const { targetNewRank, sameTypePeerUpdates } =
            await computeAndApplyTypedReposition(
              existingConfig.id,
              'preExisting',
              existingConfig.libraryId,
              parsedRank
            );

          if (sameTypePeerUpdates.length > 0) {
            const allConfigs = preExistingCollectionConfigService.getConfigs();
            const rankById = new Map(
              sameTypePeerUpdates.map((u) => [u.id, u.sortOrderLibrary])
            );
            preExistingCollectionConfigService.saveExistingConfigs(
              allConfigs.map((c) => {
                const newRank = rankById.get(c.id);
                return newRank !== undefined
                  ? { ...c, sortOrderLibrary: newRank }
                  : c;
              })
            );
            for (const peerUpdate of sameTypePeerUpdates) {
              const { getSettings } = await import('@server/lib/settings');
              getSettings().markCollectionModified(
                peerUpdate.id,
                'preExisting'
              );
            }
          }

          req.body.sortOrderLibrary = targetNewRank;
          req.body.isLibraryPromoted = true;
          req.body.sortTitleOverride = '';

          logger.info(
            `Typed Sort Title reposition: moving "${existingConfig.name}" to rank ${targetNewRank}`,
            {
              label: 'Pre-existing Collections API',
              collectionId: existingConfig.id,
              fromRank: existingConfig.sortOrderLibrary,
              toRank: targetNewRank,
              peersShifted: sameTypePeerUpdates.length,
            }
          );
        } else if (parsedRank !== undefined) {
          // Typed rank equals the rank already held: nothing moves, but the
          // value still means position, so clear the override and let the
          // computed prefix apply.
          req.body.sortTitleOverride = '';
        }
      }
    }

    const updatedConfig = preExistingCollectionConfigService.updateSettings(
      id,
      req.body
    );

    // Mark pre-existing collection as needing sync due to modification
    const { getSettings } = await import('@server/lib/settings');
    const settings = getSettings();
    settings.markCollectionModified(id, 'preExisting');

    // Auto-reorder after visibility changes to assign proper sort orders
    const { autoReorderLibrary } = await import('@server/routes/reorder');
    try {
      await autoReorderLibrary(updatedConfig.libraryId, 'home');
      await autoReorderLibrary(updatedConfig.libraryId, 'library');
      logger.debug(
        `Auto-reordering completed after pre-existing collection settings update for library ${updatedConfig.libraryId}`,
        {
          label: 'Pre-existing Collections API - Auto Reorder',
        }
      );
    } catch (error) {
      logger.warn(
        'Failed to auto-reorder after pre-existing collection settings update',
        {
          label: 'Pre-existing Collections API - Auto Reorder',
          libraryId: updatedConfig.libraryId,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      // Don't fail the settings update if reordering fails
    }

    res.status(200).json({
      preExistingCollectionConfig: updatedConfig,
      message: 'Pre-existing collection settings updated successfully',
    });
  } catch (error) {
    logger.error(
      'Failed to update individual pre-existing collection settings',
      {
        label: 'Pre-existing Collections API',
        error: error instanceof Error ? error.message : String(error),
        configId: id,
      }
    );

    if (error instanceof Error && error.message === 'Config not found') {
      return res.status(404).json({
        error: 'Pre-existing collection not found',
        message: `Pre-existing collection with id "${id}" not found`,
      });
    }

    res.status(500).json({
      error: 'Failed to update pre-existing collection settings',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/v1/preexisting/discover
 * Discovery operation for new pre-existing collections
 */
preExistingRoutes.post('/discover', isAuthenticated(), async (req, res) => {
  try {
    const { preExistingCollectionConfigs } = req.body;

    if (!Array.isArray(preExistingCollectionConfigs)) {
      return res.status(400).json({
        error: 'Invalid preExistingCollectionConfigs: must be an array',
      });
    }

    const discoveredConfigs = preExistingCollectionConfigService.saveConfigs(
      preExistingCollectionConfigs
    );

    // Mark all newly discovered pre-existing collections as needing sync
    const { getSettings } = await import('@server/lib/settings');
    const settings = getSettings();
    discoveredConfigs.forEach((config) => {
      settings.markCollectionModified(config.id, 'preExisting');
    });

    res.status(200).json({
      preExistingCollectionConfigs: discoveredConfigs,
      message: 'Pre-existing collections discovered successfully',
    });
  } catch (error) {
    logger.error('Failed to discover pre-existing collections', {
      label: 'Pre-existing Collections API',
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      error: 'Failed to discover pre-existing collections',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/v1/preexisting
 * Save pre-existing collection configurations (replaces entire config array)
 */
preExistingRoutes.post('/', isAuthenticated(), async (req, res) => {
  try {
    const { preExistingCollectionConfigs } = req.body;

    if (!Array.isArray(preExistingCollectionConfigs)) {
      return res.status(400).json({
        error: 'Invalid preExistingCollectionConfigs: must be an array',
      });
    }

    // Determine if we're receiving discovered configs (with hubIdentifier) or existing configs (with collectionRatingKey)
    const firstConfig = preExistingCollectionConfigs[0];
    let savedConfigs;

    if (firstConfig && 'hubIdentifier' in firstConfig) {
      // This is discovery data - use saveConfigs for conversion
      savedConfigs = preExistingCollectionConfigService.saveConfigs(
        preExistingCollectionConfigs
      );
    } else {
      // This is existing config data (reordering/editing) - use saveExistingConfigs
      savedConfigs = preExistingCollectionConfigService.saveExistingConfigs(
        preExistingCollectionConfigs
      );
    }

    res.status(200).json({
      preExistingCollectionConfigs: savedConfigs,
      message: 'Pre-existing collection configurations saved successfully',
    });
  } catch (error) {
    logger.error('Failed to save pre-existing collection configurations', {
      label: 'Pre-existing Collections API',
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      error: 'Failed to save pre-existing collection configurations',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/v1/preexisting/append
 * Append new pre-existing collection configurations to existing ones (for discovery)
 */
preExistingRoutes.post('/append', isAuthenticated(), async (req, res) => {
  try {
    const { preExistingCollectionConfigs } = req.body;

    if (!Array.isArray(preExistingCollectionConfigs)) {
      return res.status(400).json({
        error: 'Invalid preExistingCollectionConfigs: must be an array',
      });
    }

    const appendedConfigs = preExistingCollectionConfigService.appendConfigs(
      preExistingCollectionConfigs
    );

    // Mark all newly appended pre-existing collections as needing sync
    const { getSettings } = await import('@server/lib/settings');
    const settings = getSettings();
    appendedConfigs.forEach((config) => {
      settings.markCollectionModified(config.id, 'preExisting');
    });

    res.status(200).json({
      preExistingCollectionConfigs: appendedConfigs,
      message: 'Pre-existing collection configurations appended successfully',
    });
  } catch (error) {
    logger.error('Failed to append pre-existing collection configurations', {
      label: 'Pre-existing Collections API',
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      error: 'Failed to append pre-existing collection configurations',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * PATCH /api/v1/preexisting/:id/promote
 * Promote a pre-existing collection from A-Z section to promoted section
 */
preExistingRoutes.patch('/:id/promote', isAuthenticated(), async (req, res) => {
  try {
    const { id } = req.params;
    const configs = preExistingCollectionConfigService.getConfigs();

    // Find the collection to promote
    const configIndex = configs.findIndex((config) => config.id === id);
    if (configIndex === -1) {
      return res
        .status(404)
        .json({ error: 'Pre-existing collection not found' });
    }

    const config = configs[configIndex];

    // Check if already promoted
    if (config.isLibraryPromoted) {
      return res
        .status(400)
        .json({ error: 'Collection is already in promoted section' });
    }

    // Land at targetRank when the caller asked for one - that's the typed
    // "!005_Name" rank being replayed after the user confirmed the
    // promotion prompt. Without one, append to the bottom. Either way
    // "bottom" has to be computed across ALL three config types sharing
    // this library's rank space (regular collections, pre-existing
    // collections, default hubs), not just this route's own array, or it
    // can collide with a rank a regular or hub collection already holds.
    // Requesting an out-of-range rank makes computeReposition clamp to the
    // true bottom of the full unified peer list.
    const requestedRank =
      typeof req.body?.targetRank === 'number' && req.body.targetRank > 0
        ? req.body.targetRank
        : Number.MAX_SAFE_INTEGER;
    const { computeAndApplyTypedReposition } = await import(
      '@server/lib/collections/core/TypedRepositionService'
    );
    const { targetNewRank, sameTypePeerUpdates } =
      await computeAndApplyTypedReposition(
        id,
        'preExisting',
        config.libraryId,
        requestedRank
      );

    if (sameTypePeerUpdates.length > 0) {
      const rankById = new Map(
        sameTypePeerUpdates.map((u) => [u.id, u.sortOrderLibrary])
      );
      preExistingCollectionConfigService.saveExistingConfigs(
        configs.map((c) => {
          const newRank = rankById.get(c.id);
          return newRank !== undefined
            ? { ...c, sortOrderLibrary: newRank }
            : c;
        })
      );
    }

    // Update in service. Any Sort Title override is dropped, not just a
    // "!"-prefixed one: promoting says "put this at rank N", and only the
    // positional scheme can express that. Leaving a literal value behind
    // would have the next sync write it to Plex and undo the promotion.
    const finalConfig = preExistingCollectionConfigService.updateSettings(id, {
      isLibraryPromoted: true,
      sortOrderLibrary: targetNewRank,
      everLibraryPromoted: true, // Mark as ever promoted when promoting
      ...(config.sortTitleOverride ? { sortTitleOverride: '' } : {}),
    });

    // Mark pre-existing collection as needing sync due to promotion
    const { getSettings } = await import('@server/lib/settings');
    const settings = getSettings();
    settings.markCollectionModified(id, 'preExisting');
    for (const peerUpdate of sameTypePeerUpdates) {
      settings.markCollectionModified(peerUpdate.id, 'preExisting');
    }

    logger.info(
      `Promoted pre-existing collection ${config.name} to promoted section`,
      {
        label: 'Pre-existing Collections API',
        collectionId: id,
        newSortOrderLibrary: targetNewRank,
        peersShifted: sameTypePeerUpdates.length,
      }
    );

    return res.json({ success: true, config: finalConfig });
  } catch (error) {
    logger.error(`Failed to promote pre-existing collection ${req.params.id}`, {
      label: 'Pre-existing Collections API',
      error: error instanceof Error ? error.message : String(error),
    });

    return res
      .status(500)
      .json({ error: 'Failed to promote pre-existing collection' });
  }
});

/**
 * PATCH /api/v1/preexisting/:id/demote
 * Demote a pre-existing collection from promoted section to A-Z section
 */
preExistingRoutes.patch('/:id/demote', isAuthenticated(), async (req, res) => {
  try {
    const { id } = req.params;
    const configs = preExistingCollectionConfigService.getConfigs();

    // Find the collection to demote
    const configIndex = configs.findIndex((config) => config.id === id);
    if (configIndex === -1) {
      return res
        .status(404)
        .json({ error: 'Pre-existing collection not found' });
    }

    const config = configs[configIndex];

    // Check if already in A-Z section
    if (!config.isLibraryPromoted) {
      return res
        .status(400)
        .json({ error: 'Collection is already in A-Z section' });
    }

    // Update in service - Keep everLibraryPromoted: true when demoting.
    // A "!"-prefixed override has to go: Plex decides the section purely
    // from whether sortTitle starts with "!", so keeping one would leave
    // Agregarr showing A-Z while Plex puts it back in promoted on the next
    // sync. Any other override is a deliberate A-Z sort choice and stays.
    const finalConfig = preExistingCollectionConfigService.updateSettings(id, {
      isLibraryPromoted: false,
      sortOrderLibrary: 0, // A-Z collections have sortOrderLibrary: 0
      // Note: everLibraryPromoted stays true when demoting - will be reset to false during sync after sortTitle cleanup
      ...(config.sortTitleOverride?.startsWith('!') === true
        ? { sortTitleOverride: '' }
        : {}),
    });

    // Mark pre-existing collection as needing sync due to demotion
    const { getSettings } = await import('@server/lib/settings');
    const settings = getSettings();
    settings.markCollectionModified(id, 'preExisting');

    // Demoting only ever clears this one collection's own rank - nothing
    // else shifts down to fill the hole it leaves behind, so the promoted
    // sequence can drift away from a clean 1..N over repeated demotes (see
    // compactPromotedRanks). Close that gap now, across all three config
    // types sharing this library's rank space.
    const { compactAndApplyPromotedRanks } = await import(
      '@server/lib/collections/core/TypedRepositionService'
    );
    await compactAndApplyPromotedRanks(config.libraryId);

    logger.info(
      `Demoted pre-existing collection ${config.name} to A-Z section`,
      {
        label: 'Pre-existing Collections API',
        collectionId: id,
      }
    );

    return res.json({ success: true, config: finalConfig });
  } catch (error) {
    logger.error(`Failed to demote pre-existing collection ${req.params.id}`, {
      label: 'Pre-existing Collections API',
      error: error instanceof Error ? error.message : String(error),
    });

    return res
      .status(500)
      .json({ error: 'Failed to demote pre-existing collection' });
  }
});

export default preExistingRoutes;

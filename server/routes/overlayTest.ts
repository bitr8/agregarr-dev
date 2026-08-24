import type { MaintainerrCollection } from '@server/api/maintainerr';
import PlexAPI, { type PlexLibraryItem } from '@server/api/plexapi';
import { getRepository } from '@server/datasource';
import { OverlayLibraryConfig } from '@server/entity/OverlayLibraryConfig';
import { OverlayTemplate } from '@server/entity/OverlayTemplate';
import { seasonFallbackFor } from '@server/lib/overlays/maintainerrCountdown';
import {
  buildRenderContext,
  checkMonitoringStatus,
  fetchReleaseDateInfo,
} from '@server/lib/overlays/OverlayContextBuilder';
import { overlayLibraryService } from '@server/lib/overlays/OverlayLibraryService';
import { normalizeOverlayJpegQuality } from '@server/lib/overlays/overlayOutputQuality';
import { buildSpecificOverlayItem } from '@server/lib/overlays/overlaySyncItems';
import {
  targetsArtwork,
  type OverlayArtworkTarget,
} from '@server/lib/overlays/overlayTargets';
import type { OverlayRenderContext } from '@server/lib/overlays/OverlayTemplateRenderer';
import {
  evaluateConditionDetailed,
  overlayTemplateRenderer,
} from '@server/lib/overlays/OverlayTemplateRenderer';
import { deriveReleaseDateContext } from '@server/lib/overlays/releaseDateContext';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { extractUsedContextFields } from '@server/utils/metadataHashing';
import { Router } from 'express';
import type sharp from 'sharp';

const overlayTestRouter = Router();

/**
 * Test overlay application on a single Plex item
 * POST /api/v1/overlay-test
 * Body: { ratingKey: string }
 */
overlayTestRouter.post('/', async (req, res) => {
  try {
    const { ratingKey } = req.body;

    if (!ratingKey || typeof ratingKey !== 'string') {
      return res.status(400).json({ error: 'ratingKey is required' });
    }

    logger.info('Starting overlay test', {
      label: 'OverlayTest',
      ratingKey,
    });

    // Get admin user for Plex API access
    const { getAdminUser } = await import(
      '@server/lib/collections/core/CollectionUtilities'
    );
    const admin = await getAdminUser();

    if (!admin) {
      return res.status(500).json({ error: 'No admin user found' });
    }

    const plexApi = new PlexAPI({ plexToken: admin.plexToken });

    // Fetch item metadata
    const item = await plexApi.getMetadata(ratingKey);

    if (!item) {
      return res.status(404).json({ error: 'Item not found in Plex' });
    }

    const target: OverlayArtworkTarget =
      item.type === 'season'
        ? 'season'
        : item.type === 'episode'
        ? 'episode'
        : 'main';

    // Get library information
    const libraryId = (
      item as { librarySectionID?: string }
    ).librarySectionID?.toString();
    if (!libraryId) {
      return res.status(400).json({ error: 'Could not determine library ID' });
    }

    let libraryName =
      (item as { librarySectionTitle?: string }).librarySectionTitle ||
      'Unknown Library';
    if (!(item as { librarySectionTitle?: string }).librarySectionTitle) {
      try {
        const libraries = await plexApi.getLibraries();
        const library = libraries.find((lib) => lib.key === libraryId);
        libraryName = library?.title || 'Unknown Library';
      } catch (error) {
        logger.warn('Failed to fetch library name', {
          label: 'OverlayTest',
          libraryId,
        });
      }
    }

    // Get library configuration
    const configRepository = getRepository(OverlayLibraryConfig);
    const config = await configRepository.findOne({
      where: { libraryId },
    });

    if (!config || config.enabledOverlays.length === 0) {
      return res.status(400).json({
        error: `No overlays enabled for library "${libraryName}"`,
        item: {
          ratingKey: item.ratingKey,
          title: item.title,
          year: (item as { year?: number }).year,
          type: item.type,
          libraryId,
          libraryName,
        },
      });
    }

    // Get enabled overlay templates
    const templateRepository = getRepository(OverlayTemplate);
    const enabledTemplateIds = config.enabledOverlays
      .filter((o) => o.enabled)
      .map((o) => o.templateId);

    const templates = (
      await templateRepository.findByIds(enabledTemplateIds)
    ).filter((template) => targetsArtwork(template.getTags(), target));

    if (templates.length === 0) {
      return res.status(400).json({
        error: `No enabled templates target ${target} artwork in library "${libraryName}"`,
      });
    }

    // Sort templates by layer order
    const sortedTemplates = templates.sort((a, b) => {
      const orderA =
        config.enabledOverlays.find((o) => o.templateId === a.id)?.layerOrder ||
        0;
      const orderB =
        config.enabledOverlays.find((o) => o.templateId === b.id)?.layerOrder ||
        0;
      return orderA - orderB;
    });

    // Derive actual media type from item.type
    const actualMediaType: 'movie' | 'show' =
      item.type === 'movie' ? 'movie' : 'show';

    // Extract TMDB ID from item GUIDs
    let tmdbId: number | undefined;
    if (target === 'main' && item.Guid && Array.isArray(item.Guid)) {
      const tmdbGuid = item.Guid.find((g) => g.id?.includes('tmdb://'));
      if (tmdbGuid) {
        const match = tmdbGuid.id.match(/tmdb:\/\/(\d+)/);
        if (match) {
          tmdbId = parseInt(match[1]);
        }
      }
    }

    const specificItem = buildSpecificOverlayItem(
      item as unknown as PlexLibraryItem
    );
    const renderItem = {
      ...item,
      // Child TMDB GUIDs use season/episode namespaces and must not be sent to
      // show endpoints. Episode IMDb GUIDs remain valid for its own rating.
      Guid:
        target === 'episode'
          ? item.Guid?.filter((guid) => guid.id?.startsWith('imdb://'))
          : target === 'season'
          ? undefined
          : item.Guid,
    } as unknown as PlexLibraryItem;

    // Check if this is a placeholder. Child artwork is always real Plex media;
    // the placeholder heuristic is only meaningful for root movie/show items.
    const { placeholderContextService } = await import(
      '@server/lib/placeholders/services/PlaceholderContextService'
    );
    const plexMetadata = renderItem as {
      type: string;
      guid?: string;
      editionTitle?: string;
      Guid?: { id: string }[];
      childCount?: number;
      Children?: { Metadata?: unknown[]; Directory?: unknown[] };
      seasonCount?: number;
      leafCount?: number;
      ratingKey?: string;
    };

    const isPlaceholder =
      target === 'main'
        ? await placeholderContextService.isPlaceholderItemAsync(
            plexMetadata,
            plexApi['plexClient'] as {
              query: (path: string) => Promise<{
                MediaContainer?: {
                  Directory?: unknown[];
                  Metadata?: unknown[];
                };
              }>;
            }
          )
        : false;

    logger.debug('Placeholder detection result', {
      label: 'OverlayTest',
      itemTitle: item.title,
      ratingKey: item.ratingKey,
      isPlaceholder,
    });

    // Fetch Maintainerr collections for daysUntilAction context
    const settings = getSettings();
    let maintainerrCollections: MaintainerrCollection[] | undefined;

    if (settings.maintainerr?.hostname && settings.maintainerr?.apiKey) {
      try {
        const MaintainerrAPI = (await import('@server/api/maintainerr'))
          .default;
        const maintainerrClient = new MaintainerrAPI(settings.maintainerr);
        maintainerrCollections = await maintainerrClient.getCollections();
        logger.debug('Fetched Maintainerr collections for overlay test', {
          label: 'OverlayTest',
          collectionsCount: maintainerrCollections.length,
        });
      } catch (error) {
        logger.debug('Failed to fetch Maintainerr collections', {
          label: 'OverlayTest',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const requiredContextFields = extractUsedContextFields(
      sortedTemplates.map((template) => template.getTemplateData()),
      sortedTemplates.map((template) => template.getApplicationCondition())
    );

    let fallbackContext: Partial<OverlayRenderContext> = {};
    if (specificItem.contextFallbackRatingKey) {
      try {
        const fallbackMetadata = await plexApi.getMetadata(
          specificItem.contextFallbackRatingKey
        );
        const fallbackResult = await buildRenderContext(
          fallbackMetadata as unknown as PlexLibraryItem,
          'show',
          false,
          undefined,
          undefined,
          requiredContextFields,
          seasonFallbackFor(config)
        );
        fallbackContext = fallbackResult.context;
      } catch (error) {
        logger.warn('Failed to build parent-show context for overlay test', {
          label: 'OverlayTest',
          ratingKey,
          parentRatingKey: specificItem.contextFallbackRatingKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let contextOverrides = specificItem.contextOverrides ?? {};
    if (target === 'season' && requiredContextFields.has('imdbRating')) {
      const seasonRatings = await overlayLibraryService.fetchSeasonImdbRatings(
        plexApi,
        [ratingKey]
      );
      contextOverrides = {
        ...contextOverrides,
        // Explicit undefined prevents the parent show's rating from leaking
        // into a season that has no IMDb-rated episodes.
        imdbRating: seasonRatings.get(ratingKey),
      };
    }

    // Build the selected item's context using the same target-aware metadata
    // and parent fallback policy as a real sync.
    const contextResult = await buildRenderContext(
      renderItem,
      actualMediaType,
      isPlaceholder,
      maintainerrCollections,
      undefined,
      requiredContextFields,
      // Same derivation as a real library run, so a test never shows a
      // season-derived countdown the library itself would withhold.
      seasonFallbackFor(config)
    );

    // For test endpoint, log warning but continue even if APIs failed
    if (contextResult.criticalApiFailed) {
      logger.warn(
        'Critical API failed during overlay test - proceeding anyway',
        {
          label: 'OverlayTest',
          itemTitle: item.title,
          ratingKey: item.ratingKey,
        }
      );
    }

    const baseContext: OverlayRenderContext = {
      ...fallbackContext,
      ...contextResult.context,
      ...contextOverrides,
    };

    // Fetch release date information if TMDB ID available
    let releaseDateContext: Partial<OverlayRenderContext> = {};
    if (tmdbId) {
      const releaseDateInfo = await fetchReleaseDateInfo(
        tmdbId,
        actualMediaType
      );

      if (releaseDateInfo) {
        // Same shared read-time derivation as the overlay sync path, so the
        // test route and the real render can never diverge on a passed
        // next-episode date (fork#35).
        releaseDateContext = deriveReleaseDateContext(releaseDateInfo);
      }
    }

    // Check monitoring status if TMDB ID available
    let monitoringContext: Partial<OverlayRenderContext> = {};
    if (tmdbId) {
      monitoringContext = await checkMonitoringStatus(
        tmdbId,
        actualMediaType,
        undefined,
        undefined
      );
    }

    // Merge contexts
    let actualIsPlaceholder = isPlaceholder;
    if (monitoringContext.hasFile === true) {
      actualIsPlaceholder = false; // *arr has files, so it's definitely not a placeholder
    }

    let downloaded: boolean;
    if (actualIsPlaceholder) {
      downloaded = false;
    } else if (typeof monitoringContext.hasFile === 'boolean') {
      downloaded = monitoringContext.hasFile;
    } else {
      downloaded = true;
    }

    // Build collection membership for condition evaluation
    const allConfigs: { id: string; collectionRatingKey?: string }[] = [
      ...(settings.plex.collectionConfigs || []),
    ];

    const { preExistingCollectionConfigService } = await import(
      '@server/lib/collections/services/PreExistingCollectionConfigService'
    );
    allConfigs.push(...preExistingCollectionConfigService.getConfigs());

    const collectionsWithKeys = allConfigs.filter(
      (cfg): cfg is typeof cfg & { collectionRatingKey: string } =>
        !!cfg.collectionRatingKey
    );
    const collectionIds: string[] = [];
    const concurrency = 10;

    for (let i = 0; i < collectionsWithKeys.length; i += concurrency) {
      const batch = collectionsWithKeys.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(async (cfg) => {
          try {
            const itemKeys = await plexApi.getCollectionItems(
              cfg.collectionRatingKey
            );
            return itemKeys.includes(ratingKey) ? cfg.id : null;
          } catch {
            return null;
          }
        })
      );
      for (const id of results) {
        if (id) collectionIds.push(id);
      }
    }

    logger.debug('Collection membership for test item', {
      label: 'OverlayTest',
      ratingKey,
      collectionIds,
      totalCollectionsChecked: allConfigs.filter((c) => c.collectionRatingKey)
        .length,
    });

    const context: OverlayRenderContext = {
      ...baseContext,
      isPlaceholder: actualIsPlaceholder,
      downloaded,
      ...releaseDateContext,
      ...monitoringContext,
      collection: collectionIds,
    };

    // Evaluate all templates with detailed results
    const templateResults = sortedTemplates.map((template) => {
      const condition = template.getApplicationCondition();
      const detailedResult = evaluateConditionDetailed(condition, context);

      return {
        id: template.id,
        name: template.name,
        matched: detailedResult.matched,
        appliedCondition: condition,
        conditionResults: {
          sectionResults: detailedResult.sectionResults,
        },
      };
    });

    // Get poster source preference (reuse settings from earlier)
    const posterSource =
      target === 'main'
        ? settings.overlays?.defaultPosterSource || 'tmdb'
        : 'plex';

    // Fetch base poster
    const { plexBasePosterManager } = await import(
      '@server/lib/overlays/PlexBasePosterManager'
    );

    let basePosterResult: {
      posterBuffer: Buffer;
      basePosterChanged: boolean;
      sourceUrl: string;
      filename: string;
      fileModTime?: number | null;
    };

    try {
      basePosterResult = await plexBasePosterManager.getBasePosterForOverlay(
        plexApi,
        renderItem,
        libraryId,
        libraryName,
        config.mediaType,
        posterSource,
        {},
        tmdbId
      );
    } catch (error) {
      logger.error('Failed to get base poster', {
        label: 'OverlayTest',
        itemTitle: item.title,
        ratingKey: item.ratingKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(500).json({
        error: 'Failed to fetch base poster',
        message: error instanceof Error ? error.message : String(error),
      });
    }

    let posterBuffer = basePosterResult.posterBuffer;

    // Apply matching overlays in order via batch rendering
    const matchingTemplates = sortedTemplates.filter(
      (template) => templateResults.find((tr) => tr.id === template.id)?.matched
    );

    const { width: posterWidth, height: posterHeight } =
      await overlayTemplateRenderer.getPosterDimensions(posterBuffer);
    const allOverlays: sharp.OverlayOptions[] = [];

    for (const template of matchingTemplates) {
      const templateData = template.getTemplateData();
      const templateOverlays =
        await overlayTemplateRenderer.renderOverlayElements(
          posterWidth,
          posterHeight,
          templateData,
          context
        );

      if (templateOverlays) {
        allOverlays.push(...templateOverlays);
      }
    }

    const jpegQuality = normalizeOverlayJpegQuality(
      settings.overlays?.jpegQuality
    );
    posterBuffer = await overlayTemplateRenderer.compositeOverlays(
      posterBuffer,
      allOverlays,
      jpegQuality
    );

    // Return all context variables as a flat list (no grouping)
    const allContext: Record<string, unknown> = {};
    for (const key in context) {
      allContext[key] = context[key as keyof typeof context];
    }

    logger.info('Overlay test completed successfully', {
      label: 'OverlayTest',
      ratingKey,
      itemTitle: item.title,
      templatesEvaluated: templateResults.length,
      templatesMatched: matchingTemplates.length,
    });

    return res.status(200).json({
      poster: posterBuffer.toString('base64'),
      item: {
        ratingKey: item.ratingKey,
        title: item.title,
        year: (item as { year?: number }).year,
        type: item.type,
        libraryId,
        libraryName,
      },
      templates: templateResults,
      context: allContext,
      output: {
        width: posterWidth,
        height: posterHeight,
        jpegQuality,
        bytes: posterBuffer.length,
      },
    });
  } catch (error) {
    logger.error('Failed to test overlay', {
      label: 'OverlayTest',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return res.status(500).json({
      error: 'Failed to test overlay',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

export default overlayTestRouter;

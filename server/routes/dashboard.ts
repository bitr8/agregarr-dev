import { getRepository } from '@server/datasource';
import { JobRunHistory } from '@server/entity/JobRunHistory';
import { getSettings } from '@server/lib/settings';
import {
  getStatisticsProvider,
  getStatisticsProviderDisplayName,
  getStatisticsProviderType,
} from '@server/lib/statistics';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import type { Response } from 'express';
import { Router } from 'express';

const dashboardRoutes = Router();

/**
 * Rating keys of every collection Agregarr knows about (its own plus
 * pre-existing ones it manages).
 */
function getConfiguredCollectionRatingKeys(): string[] {
  const settings = getSettings();
  const collectionRatingKeys: string[] = [];

  for (const config of settings.plex.collectionConfigs ?? []) {
    if (config.collectionRatingKey) {
      collectionRatingKeys.push(config.collectionRatingKey);
    }
  }

  for (const config of settings.plex.preExistingCollectionConfigs ?? []) {
    if (config.collectionRatingKey) {
      collectionRatingKeys.push(config.collectionRatingKey);
    }
  }

  return collectionRatingKeys;
}

function providerNotConfigured(res: Response, what: string) {
  const name = getStatisticsProviderDisplayName();
  return res.status(400).json({
    error: 'Statistics provider not configured',
    message: `${name} settings are required to fetch ${what}`,
    provider: getStatisticsProviderType(),
  });
}

/**
 * GET /api/v1/dashboard/stats
 * Get dashboard statistics including collection stats, user activity, etc.
 */
dashboardRoutes.get('/stats', isAuthenticated(), async (req, res) => {
  try {
    const settings = getSettings();
    const provider = getStatisticsProvider();

    let statisticsStatus = null;
    let collectionStatsData = null;
    let weeklyStats = null;

    // Get watch stats if a statistics provider is configured
    if (provider) {
      try {
        const collectionRatingKeys = getConfiguredCollectionRatingKeys();

        // Get collection stats and weekly activity stats
        const [collectionStats, weeklyMovies, weeklyTV] = await Promise.all([
          provider
            .getTopCollections(50, 'plays', 7, collectionRatingKeys)
            .catch((err) => {
              logger.warn(
                `Failed to get collection stats from ${provider.displayName}`,
                {
                  label: 'Dashboard API',
                  error: err.message,
                }
              );
              return [];
            }),
          provider
            .getContent('movie', 7, 'plays', 'most_watched', 10)
            .catch(() => []),
          provider
            .getContent('tv', 7, 'plays', 'most_watched', 10)
            .catch(() => []),
        ]);

        // Calculate weekly plays from server totals
        let moviePlaysCount = 0;
        let tvPlaysCount = 0;

        weeklyMovies.forEach((item) => {
          moviePlaysCount += item.total_plays || 0;
        });

        weeklyTV.forEach((item) => {
          tvPlaysCount += item.total_plays || 0;
        });

        const totalWeeklyPlays = moviePlaysCount + tvPlaysCount;

        // Calculate collection-specific plays
        let collectionTotalPlays = 0;
        let collectionMoviePlays = 0;
        let collectionTvPlays = 0;

        collectionStats.forEach((collection) => {
          collectionTotalPlays += collection.total_plays;

          // Determine if it's a movie or TV collection based on media_type or title
          // This is a simple heuristic - could be improved with better metadata
          if (
            collection.media_type === 'movie' ||
            collection.title.toLowerCase().includes('movie') ||
            collection.title.toLowerCase().includes('film')
          ) {
            collectionMoviePlays += collection.total_plays;
          } else if (
            collection.media_type === 'show' ||
            collection.title.toLowerCase().includes('tv') ||
            collection.title.toLowerCase().includes('show') ||
            collection.title.toLowerCase().includes('series')
          ) {
            collectionTvPlays += collection.total_plays;
          } else {
            // If uncertain, split evenly or assign to TV (most collections are mixed)
            collectionTvPlays += collection.total_plays;
          }
        });

        collectionStatsData = {
          topCollections: collectionStats.slice(0, 5),
          totalCollections: collectionStats.length,
          collectionPlays: {
            total: collectionTotalPlays,
            movies: collectionMoviePlays,
            tv: collectionTvPlays,
          },
        };

        weeklyStats = {
          totalPlays: totalWeeklyPlays,
          moviePlays: moviePlaysCount,
          tvPlays: tvPlaysCount,
          collectionPlays: collectionTotalPlays,
        };

        statisticsStatus = {
          isConnected: true,
          provider: provider.type,
          weeklyActivity: weeklyStats,
        };
      } catch (error) {
        logger.error(
          `Failed to fetch ${provider.displayName} stats for dashboard`,
          {
            label: 'Dashboard API',
            error: error.message,
          }
        );
        statisticsStatus = {
          isConnected: false,
          provider: provider.type,
          error: error.message,
        };
      }
    }

    // Count unique logical collections (linked configs across libraries = one)
    const configs = settings.plex.collectionConfigs || [];
    const seenLinkIds = new Set<number>();
    let agregarrCollectionCount = 0;
    for (const c of configs) {
      if (c.isLinked && c.linkId != null) {
        if (!seenLinkIds.has(c.linkId)) {
          seenLinkIds.add(c.linkId);
          agregarrCollectionCount++;
        }
      } else {
        agregarrCollectionCount++;
      }
    }
    const preExistingCollectionCount =
      settings.plex.preExistingCollectionConfigs?.length || 0;

    const dashboardData = {
      collections: {
        agregarr: agregarrCollectionCount,
        preExisting: preExistingCollectionCount,
        total: agregarrCollectionCount + preExistingCollectionCount,
        stats: collectionStatsData,
      },
      activity: weeklyStats,
      // `tautulli` is the historical field name; it now describes whichever
      // statistics provider is selected (see `provider`).
      tautulli: statisticsStatus,
      statisticsProvider: getStatisticsProviderType(),
      timestamp: new Date().toISOString(),
    };

    res.status(200).json(dashboardData);
  } catch (error) {
    logger.error('Failed to get dashboard stats', {
      label: 'Dashboard API',
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      error: 'Failed to get dashboard stats',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/v1/dashboard/collections
 * Get detailed collection statistics from the statistics provider
 */
dashboardRoutes.get('/collections', isAuthenticated(), async (req, res) => {
  try {
    const settings = getSettings();
    const { limit = 10, statType = 'plays', days = 30 } = req.query;

    const provider = getStatisticsProvider();
    if (!provider) {
      return providerNotConfigured(res, 'collection statistics');
    }

    const collectionRatingKeys = getConfiguredCollectionRatingKeys();

    logger.info('Getting collection statistics', {
      label: 'Dashboard API',
      provider: provider.type,
      agregarrCollections: settings.plex.collectionConfigs?.length || 0,
      preExistingCollections:
        settings.plex.preExistingCollectionConfigs?.length || 0,
      ratingKeysFound: collectionRatingKeys.length,
      ratingKeys: collectionRatingKeys,
    });

    if (collectionRatingKeys.length === 0) {
      logger.warn('No collections with rating keys found', {
        label: 'Dashboard API',
      });
      return res.status(200).json({
        collections: [],
        metadata: {
          limit: Number(limit),
          statType,
          days: Number(days),
          provider: provider.type,
          timestamp: new Date().toISOString(),
        },
      });
    }

    const collections = await provider.getTopCollections(
      Number(limit),
      statType as 'plays' | 'duration',
      Number(days),
      collectionRatingKeys
    );

    res.status(200).json({
      collections,
      metadata: {
        limit: Number(limit),
        statType,
        days: Number(days),
        provider: provider.type,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error('Failed to get collection statistics', {
      label: 'Dashboard API',
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      error: 'Failed to get collection statistics',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/v1/dashboard/collections/:ratingKey
 * Get detailed statistics for a specific collection
 */
dashboardRoutes.get(
  '/collections/:ratingKey',
  isAuthenticated(),
  async (req, res) => {
    try {
      const { ratingKey } = req.params;
      const { days = '1,7,30,0' } = req.query;

      const provider = getStatisticsProvider();
      if (!provider) {
        return providerNotConfigured(res, 'collection statistics');
      }

      const collectionStats = await provider.getCollectionStats(
        ratingKey,
        String(days)
      );

      res.status(200).json({
        collection: collectionStats,
        metadata: {
          ratingKey,
          queryDays: String(days),
          provider: provider.type,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error('Failed to get collection statistics', {
        label: 'Dashboard API',
        error: error instanceof Error ? error.message : String(error),
        ratingKey: req.params.ratingKey,
      });

      res.status(500).json({
        error: 'Failed to get collection statistics',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
);

/**
 * GET /api/v1/dashboard/activity
 * Get recent activity and general statistics
 */
dashboardRoutes.get('/activity', isAuthenticated(), async (req, res) => {
  try {
    const { days = 7, limit = 10 } = req.query;

    const provider = getStatisticsProvider();
    if (!provider) {
      return providerNotConfigured(res, 'activity statistics');
    }

    // Get various activity stats
    const [topMovies, topTV, info] = await Promise.all([
      provider.getContent(
        'movie',
        Number(days),
        'plays',
        'most_watched',
        Number(limit)
      ),
      provider.getContent(
        'tv',
        Number(days),
        'plays',
        'most_watched',
        Number(limit)
      ),
      provider.getInfo().catch(() => null),
    ]);

    res.status(200).json({
      activity: {
        topMovies,
        topTV,
      },
      providerInfo: info,
      // Legacy field: populated only when Tautulli is the active provider
      tautulliInfo: info?.provider === 'tautulli' ? info : null,
      metadata: {
        days: Number(days),
        limit: Number(limit),
        provider: provider.type,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error('Failed to get activity statistics', {
      label: 'Dashboard API',
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      error: 'Failed to get activity statistics',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/v1/dashboard/job-history
 * Get last run per job with detail
 */
dashboardRoutes.get('/job-history', isAuthenticated(), async (_req, res) => {
  try {
    const repo = getRepository(JobRunHistory);
    const rows = await repo
      .createQueryBuilder('r')
      .where('r.id IN (SELECT MAX(id) FROM job_run_history GROUP BY jobId)')
      .orderBy('r.startedAt', 'DESC')
      .getMany();

    res.status(200).json(rows);
  } catch (error) {
    logger.error('Failed to get job history', {
      label: 'Dashboard API',
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to get job history' });
  }
});

export default dashboardRoutes;

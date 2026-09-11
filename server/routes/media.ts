import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import Season from '@server/entity/Season';
import { User } from '@server/entity/User';
import type {
  MediaResultsResponse,
  MediaWatchDataResponse,
} from '@server/interfaces/api/mediaInterfaces';
import type { MediaWatchDataQuery } from '@server/lib/statistics';
import {
  getStatisticsProvider,
  getStatisticsProviderDisplayName,
} from '@server/lib/statistics';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';
import type { FindOneOptions } from 'typeorm';
import { In } from 'typeorm';

const mediaRoutes = Router();

mediaRoutes.get('/', async (req, res, next) => {
  const mediaRepository = getRepository(Media);

  const pageSize = req.query.take ? Number(req.query.take) : 20;
  const skip = req.query.skip ? Number(req.query.skip) : 0;

  let statusFilter = undefined;

  switch (req.query.filter) {
    case 'available':
      statusFilter = MediaStatus.AVAILABLE;
      break;
    case 'partial':
      statusFilter = MediaStatus.PARTIALLY_AVAILABLE;
      break;
    case 'allavailable':
      statusFilter = In([
        MediaStatus.AVAILABLE,
        MediaStatus.PARTIALLY_AVAILABLE,
      ]);
      break;
    case 'processing':
      statusFilter = MediaStatus.PROCESSING;
      break;
    case 'pending':
      statusFilter = MediaStatus.PENDING;
      break;
    default:
      statusFilter = undefined;
  }

  let sortFilter: FindOneOptions<Media>['order'] = {
    id: 'DESC',
  };

  switch (req.query.sort) {
    case 'modified':
      sortFilter = {
        updatedAt: 'DESC',
      };
      break;
    case 'mediaAdded':
      sortFilter = {
        mediaAddedAt: 'DESC',
      };
  }

  try {
    const [media, mediaCount] = await mediaRepository.findAndCount({
      order: sortFilter,
      where: statusFilter && {
        status: statusFilter,
      },
      take: pageSize,
      skip,
    });
    return res.status(200).json({
      pageInfo: {
        pages: Math.ceil(mediaCount / pageSize),
        pageSize,
        results: mediaCount,
        page: Math.ceil(skip / pageSize) + 1,
      },
      results: media,
    } as MediaResultsResponse);
  } catch (e) {
    next({ status: 500, message: e.message });
  }
});

mediaRoutes.post<
  {
    id: string;
    status: 'available' | 'partial' | 'processing' | 'pending' | 'unknown';
  },
  Media
>('/:id/:status', isAuthenticated(), async (req, res, next) => {
  const mediaRepository = getRepository(Media);
  const seasonRepository = getRepository(Season);

  const media = await mediaRepository.findOne({
    where: { id: Number(req.params.id) },
  });

  if (!media) {
    return next({ status: 404, message: 'Media does not exist.' });
  }

  const is4k = Boolean(req.body.is4k);

  switch (req.params.status) {
    case 'available':
      media[is4k ? 'status4k' : 'status'] = MediaStatus.AVAILABLE;

      if (media.mediaType === MediaType.TV) {
        const expectedSeasons = req.body.seasons ?? [];

        for (const expectedSeason of expectedSeasons) {
          let season = media.seasons.find(
            (s) => s.seasonNumber === expectedSeason?.seasonNumber
          );

          if (!season) {
            // Create the season if it doesn't exist
            season = seasonRepository.create({
              seasonNumber: expectedSeason?.seasonNumber,
            });
            media.seasons.push(season);
          }

          season[is4k ? 'status4k' : 'status'] = MediaStatus.AVAILABLE;
        }
      }
      break;
    case 'partial':
      if (media.mediaType === MediaType.MOVIE) {
        return next({
          status: 400,
          message: 'Only series can be set to be partially available',
        });
      }
      media.status = MediaStatus.PARTIALLY_AVAILABLE;
      break;
    case 'processing':
      media.status = MediaStatus.PROCESSING;
      break;
    case 'pending':
      media.status = MediaStatus.PENDING;
      break;
    case 'unknown':
      media.status = MediaStatus.UNKNOWN;
  }

  await mediaRepository.save(media);

  return res.status(200).json(media);
});

mediaRoutes.delete('/:id', isAuthenticated(), async (req, res, next) => {
  try {
    const mediaRepository = getRepository(Media);

    const media = await mediaRepository.findOneOrFail({
      where: { id: Number(req.params.id) },
    });

    await mediaRepository.remove(media);

    return res.status(204).send();
  } catch (e) {
    logger.error('Something went wrong fetching media in delete request', {
      label: 'Media',
      message: e.message,
    });
    next({ status: 404, message: 'Media not found' });
  }
});

mediaRoutes.get<{ id: string }, MediaWatchDataResponse>(
  '/:id/watch_data',
  isAuthenticated(),
  async (req, res, next) => {
    const provider = getStatisticsProvider();

    if (!provider) {
      return next({
        status: 404,
        message: `${getStatisticsProviderDisplayName()} API not configured.`,
      });
    }

    const media = await getRepository(Media).findOne({
      where: { id: Number(req.params.id) },
    });

    if (!media) {
      return next({ status: 404, message: 'Media does not exist.' });
    }

    try {
      const userRepository = getRepository(User);

      const response: MediaWatchDataResponse = {};

      const fetchWatchData = async (ratingKey: string) => {
        const query: MediaWatchDataQuery = {
          ratingKey,
          mediaType: media.mediaType === MediaType.MOVIE ? 'movie' : 'tv',
          tmdbId: media.tmdbId,
          tvdbId: media.tvdbId,
          imdbId: media.imdbId,
        };
        const watchData = await provider.getMediaWatchData(query);

        const users = watchData.plexUserIds.length
          ? await userRepository
              .createQueryBuilder('user')
              .where('user.plexId IN (:...plexIds)', {
                plexIds: watchData.plexUserIds,
              })
              .getMany()
          : [];

        return {
          users,
          playCount: watchData.playCount,
          playCount7Days: watchData.playCount7Days,
          playCount30Days: watchData.playCount30Days,
        };
      };

      if (media.ratingKey) {
        response.data = await fetchWatchData(media.ratingKey);
      }

      if (media.ratingKey4k) {
        response.data4k = await fetchWatchData(media.ratingKey4k);
      }

      return res.status(200).json(response);
    } catch (e) {
      logger.error('Something went wrong fetching media watch data', {
        label: 'API',
        errorMessage: e.message,
        mediaId: req.params.id,
      });
      next({ status: 500, message: 'Failed to fetch watch data.' });
    }
  }
);

export default mediaRoutes;

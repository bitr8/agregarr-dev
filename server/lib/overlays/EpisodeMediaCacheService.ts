import { getRepository } from '@server/datasource';
import { EpisodeMediaCache } from '@server/entity/EpisodeMediaCache';
import logger from '@server/logger';
import type { EpisodeMediaInfo } from './episodeMediaTypes';

const CHUNK_SIZE = 200;

export class EpisodeMediaCacheService {
  async getCachedEpisodes(
    serverId: string,
    libraryId: string
  ): Promise<{ episodes: EpisodeMediaInfo[]; hasStreamDetail: boolean }> {
    const repo = getRepository(EpisodeMediaCache);
    const rows = await repo
      .createQueryBuilder('emc')
      .where('emc.serverId = :serverId', { serverId })
      .andWhere('emc.libraryId = :libraryId', { libraryId })
      .andWhere("emc.updatedAt > datetime('now', '-7 days')")
      .getMany();

    const hasStreamDetail = rows.length > 0 && rows[0].hasStreamDetail;

    return {
      episodes: rows.map((row) => ({
        ratingKey: row.ratingKey,
        showRatingKey: row.showRatingKey,
        seasonRatingKey: row.seasonRatingKey,
        seasonNumber: row.seasonNumber,
        episodeNumber: row.episodeNumber,
        resolution: row.resolution,
        hdr: row.hdr,
        dolbyVision: row.dolbyVision,
        dolbyVisionProfile: row.dolbyVisionProfile ?? undefined,
        videoCodec: row.videoCodec,
        audioCodec: row.audioCodec,
        audioChannels: row.audioChannels,
        bitDepth: row.bitDepth,
        mediaHash: row.mediaHash,
      })),
      hasStreamDetail,
    };
  }

  async saveEpisodes(
    serverId: string,
    libraryId: string,
    episodes: EpisodeMediaInfo[],
    hasStreamDetail: boolean
  ): Promise<void> {
    if (episodes.length === 0) return;

    const repo = getRepository(EpisodeMediaCache);
    const now = new Date();

    for (let i = 0; i < episodes.length; i += CHUNK_SIZE) {
      const chunk = episodes.slice(i, i + CHUNK_SIZE);
      const entities = chunk.map((ep) => {
        const entity = new EpisodeMediaCache();
        entity.serverId = serverId;
        entity.libraryId = libraryId;
        entity.ratingKey = ep.ratingKey;
        entity.showRatingKey = ep.showRatingKey;
        entity.seasonRatingKey = ep.seasonRatingKey;
        entity.seasonNumber = ep.seasonNumber;
        entity.episodeNumber = ep.episodeNumber;
        entity.resolution = ep.resolution;
        entity.hdr = ep.hdr;
        entity.dolbyVision = ep.dolbyVision;
        entity.dolbyVisionProfile = ep.dolbyVisionProfile;
        entity.videoCodec = ep.videoCodec;
        entity.audioCodec = ep.audioCodec;
        entity.audioChannels = ep.audioChannels;
        entity.bitDepth = ep.bitDepth;
        entity.mediaHash = ep.mediaHash;
        entity.hasStreamDetail = hasStreamDetail;
        entity.updatedAt = now;
        return entity;
      });

      await repo.save(entities);
    }

    logger.info('Saved episode media cache', {
      label: 'EpisodeMediaCache',
      serverId,
      libraryId,
      episodeCount: episodes.length,
      hasStreamDetail,
    });
  }

  getStaleRatingKeys(
    cachedEpisodes: EpisodeMediaInfo[],
    freshEpisodes: EpisodeMediaInfo[]
  ): Set<string> {
    const cachedByKey = new Map(
      cachedEpisodes.map((c) => [c.ratingKey, c])
    );
    const stale = new Set<string>();

    for (const ep of freshEpisodes) {
      const cachedEp = cachedByKey.get(ep.ratingKey);
      if (!cachedEp || cachedEp.mediaHash !== ep.mediaHash) {
        stale.add(ep.ratingKey);
      }
    }

    return stale;
  }

  async cleanExpired(serverId: string, libraryId: string): Promise<void> {
    const repo = getRepository(EpisodeMediaCache);
    await repo
      .createQueryBuilder()
      .delete()
      .from(EpisodeMediaCache)
      .where('serverId = :serverId', { serverId })
      .andWhere('libraryId = :libraryId', { libraryId })
      .andWhere("updatedAt < datetime('now', '-7 days')")
      .execute();
  }
}

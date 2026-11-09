import { getRepository } from '@server/datasource';
import { EpisodeMediaCache } from '@server/entity/EpisodeMediaCache';
import logger from '@server/logger';
import type { EpisodeMediaInfo } from './episodeMediaTypes';

const CHUNK_SIZE = 200;

export function episodeFromRow(row: EpisodeMediaCache): EpisodeMediaInfo {
  return {
    ratingKey: row.ratingKey,
    showRatingKey: row.showRatingKey,
    seasonRatingKey: row.seasonRatingKey,
    seasonNumber: row.seasonNumber,
    episodeNumber: row.episodeNumber,
    resolution: row.resolution,
    hdr: row.hdr,
    dolbyVision: row.dolbyVision,
    dolbyVisionProfile: row.dolbyVisionProfile ?? undefined,
    hdr10Plus: row.hdr10Plus,
    videoCodec: row.videoCodec,
    audioCodec: row.audioCodec,
    audioProfile: row.audioProfile ?? undefined,
    audioChannels: row.audioChannels,
    bitDepth: row.bitDepth,
    mediaHash: row.mediaHash,
    hasStreamDetail: row.hasStreamDetail,
    addedAt: row.addedAt,
  };
}

export function entityFromEpisode(
  serverId: string,
  libraryId: string,
  ep: EpisodeMediaInfo,
  now: Date
): EpisodeMediaCache {
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
  entity.hdr10Plus = ep.hdr10Plus;
  entity.videoCodec = ep.videoCodec;
  entity.audioCodec = ep.audioCodec;
  // Explicit null (not undefined): TypeORM omits an undefined column
  // from the UPDATE, which would leave a stale value in place.
  entity.audioProfile = ep.audioProfile ?? null;
  entity.audioChannels = ep.audioChannels;
  entity.bitDepth = ep.bitDepth;
  entity.mediaHash = ep.mediaHash;
  entity.hasStreamDetail = ep.hasStreamDetail;
  entity.addedAt = ep.addedAt ?? null;
  entity.updatedAt = now;
  return entity;
}

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

    // The set is only "detailed" when EVERY row has stream detail. A single
    // lightweight-only row (e.g. from a partial getMetadataBatch failure)
    // makes this false so the next scan re-fetches detail instead of trusting
    // a poisoned cache. Reading rows[0] alone silently masked missing rows.
    const hasStreamDetail =
      rows.length > 0 && rows.every((row) => row.hasStreamDetail);

    return {
      episodes: rows.map(episodeFromRow),
      hasStreamDetail,
    };
  }

  async saveEpisodes(
    serverId: string,
    libraryId: string,
    episodes: EpisodeMediaInfo[]
  ): Promise<void> {
    if (episodes.length === 0) return;

    const repo = getRepository(EpisodeMediaCache);
    const now = new Date();

    for (let i = 0; i < episodes.length; i += CHUNK_SIZE) {
      const chunk = episodes.slice(i, i + CHUNK_SIZE);
      const entities = chunk.map((ep) =>
        entityFromEpisode(serverId, libraryId, ep, now)
      );

      await repo.save(entities);
    }

    logger.info('Saved episode media cache', {
      label: 'EpisodeMediaCache',
      serverId,
      libraryId,
      episodeCount: episodes.length,
      withStreamDetail: episodes.filter((ep) => ep.hasStreamDetail).length,
    });
  }

  getStaleRatingKeys(
    cachedEpisodes: EpisodeMediaInfo[],
    freshEpisodes: EpisodeMediaInfo[]
  ): Set<string> {
    const cachedByKey = new Map(cachedEpisodes.map((c) => [c.ratingKey, c]));
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

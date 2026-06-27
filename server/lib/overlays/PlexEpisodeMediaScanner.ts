import type PlexAPI from '@server/api/plexapi';
import type { PlexLibraryItem } from '@server/api/plexapi';
import logger from '@server/logger';
import { extractMediaCapabilities } from '@server/utils/mediaCapabilities';
import { createHash } from 'crypto';
import type { EpisodeMediaInfo, EpisodeMediaScanner } from './episodeMediaTypes';

function computeMediaHash(mediaArray: unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify(mediaArray))
    .digest('hex')
    .slice(0, 16);
}

export class PlexEpisodeMediaScanner implements EpisodeMediaScanner {
  constructor(private plexApi: PlexAPI) {}

  async scanLibraryEpisodes(
    libraryId: string,
    needsStreamDetail: boolean
  ): Promise<EpisodeMediaInfo[]> {
    const startTime = Date.now();

    const episodes = await this.plexApi.getLibraryItemsByType(libraryId, 4);

    logger.info('Episode list scan complete', {
      label: 'EpisodeScanner',
      libraryId,
      episodeCount: episodes.length,
      durationMs: Date.now() - startTime,
    });

    if (!needsStreamDetail) {
      return episodes
        .filter((ep) => ep.Media?.[0])
        .map((ep) => this.extractFromItem(ep));
    }

    const ratingKeys = episodes.map((ep) => ep.ratingKey);
    const batchStartTime = Date.now();
    const batchMetadata = await this.plexApi.getMetadataBatch(ratingKeys);

    logger.info('Batch metadata fetch complete', {
      label: 'EpisodeScanner',
      libraryId,
      batchSize: batchMetadata.size,
      durationMs: Date.now() - batchStartTime,
    });

    const results: EpisodeMediaInfo[] = [];

    for (const ep of episodes) {
      const metadata = batchMetadata.get(ep.ratingKey);

      const enrichedItem: PlexLibraryItem = metadata
        ? { ...ep, Media: metadata.Media }
        : ep;

      if (!enrichedItem.Media?.[0]) continue;

      results.push(this.extractFromItem(enrichedItem));
    }

    logger.info('Episode media scan complete', {
      label: 'EpisodeScanner',
      libraryId,
      totalEpisodes: results.length,
      totalDurationMs: Date.now() - startTime,
    });

    return results;
  }

  private extractFromItem(ep: PlexLibraryItem): EpisodeMediaInfo {
    const media = ep.Media[0];
    const streams = media.Part?.[0]?.Stream;

    const caps = extractMediaCapabilities(media, streams);

    return {
      ratingKey: ep.ratingKey,
      showRatingKey: ep.grandparentRatingKey || '',
      seasonRatingKey: ep.parentRatingKey || '',
      seasonNumber: ep.parentIndex ?? 0,
      episodeNumber: ep.index ?? 0,
      ...caps,
      mediaHash: computeMediaHash(ep.Media),
    };
  }
}

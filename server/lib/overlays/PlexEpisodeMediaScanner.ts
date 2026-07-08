import type PlexAPI from '@server/api/plexapi';
import type { PlexLibraryItem, PlexMetadata } from '@server/api/plexapi';
import logger from '@server/logger';
import { extractMediaCapabilities } from '@server/utils/mediaCapabilities';
import { createHash } from 'crypto';
import type {
  EpisodeMediaInfo,
  EpisodeMediaScanner,
} from './episodeMediaTypes';

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
        .map((ep) => this.extractFromItem(ep, false));
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

      // Only count it as detail-fetched if the batch actually returned this
      // item; a dropped item falls back to lightweight data and must be
      // retried on the next scan.
      results.push(this.extractFromItem(enrichedItem, !!metadata));
    }

    logger.info('Episode media scan complete', {
      label: 'EpisodeScanner',
      libraryId,
      totalEpisodes: results.length,
      totalDurationMs: Date.now() - startTime,
    });

    return results;
  }

  private extractFromItem(
    ep: PlexLibraryItem,
    streamDetailFetched: boolean
  ): EpisodeMediaInfo {
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
      // Owned by the caller: a lightweight list scan has not fetched stream
      // detail (its caps are Plex-list defaults), so it passes false; the
      // full-detail pass passes true. See resolveFetchedEpisodeDetail.
      hasStreamDetail: streamDetailFetched,
    };
  }
}

/**
 * Resolve one episode's media info after a stream-detail fetch pass.
 *
 * `metadata` is the item's getMetadataBatch response, or undefined when the
 * batch call dropped it (a partial failure). The rules:
 * - No response: leave the lightweight row untouched (hasStreamDetail stays
 *   false), so the next scan retries the fetch for it.
 * - Response with a usable video stream: extract real capabilities and mark it
 *   detail-fetched.
 * - Response with no usable stream (empty Part.Stream, unanalysed / optimised /
 *   remote file): keep the lightweight values but still mark it detail-fetched,
 *   so a genuinely stream-less item isn't re-fetched on every scan.
 *
 * Keeping the flag to mean "a fetch was completed" (not "a stream array was
 * present") is what lets rows.every(hasStreamDetail) both self-heal transient
 * failures and converge on items that will never have stream detail.
 */
export function resolveFetchedEpisodeDetail(
  lightweightEp: EpisodeMediaInfo,
  metadata: PlexMetadata | undefined
): EpisodeMediaInfo {
  if (!metadata) {
    return lightweightEp;
  }

  const media = metadata.Media?.[0];
  const streams = media?.Part?.[0]?.Stream;

  if (media && streams && streams.length > 0) {
    return {
      ...lightweightEp,
      ...extractMediaCapabilities(media, streams),
      hasStreamDetail: true,
    };
  }

  return { ...lightweightEp, hasStreamDetail: true };
}

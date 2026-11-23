import type PlexAPI from '@server/api/plexapi';
import type {
  Media,
  PlexLibraryItem,
  PlexMetadata,
  PlexStream,
} from '@server/api/plexapi';
import logger from '@server/logger';
import type { MediaCapabilities } from '@server/utils/mediaCapabilities';
import { extractMediaCapabilities } from '@server/utils/mediaCapabilities';
import { createHash } from 'crypto';
import type {
  EpisodeMediaInfo,
  EpisodeMediaScanner,
} from './episodeMediaTypes';
import { bestVersionRank, UNKNOWN_RESOLUTION } from './episodeResolution';

function computeMediaHash(mediaArray: unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify(mediaArray))
    .digest('hex')
    .slice(0, 16);
}

// First entry wins a tie.
function bestMediaIndex(media: Media[]): number {
  let best = 0;
  for (let i = 1; i < media.length; i++) {
    if (
      bestVersionRank(media[i].videoResolution) >
      bestVersionRank(media[best].videoResolution)
    ) {
      best = i;
    }
  }
  return best;
}

function extractEpisodeCapabilities(
  media: Media,
  streams?: PlexStream[]
): MediaCapabilities {
  const caps = extractMediaCapabilities(media, streams);
  return media.videoResolution
    ? caps
    : { ...caps, resolution: UNKNOWN_RESOLUTION };
}

function isPlaceholderFile(file: string | undefined): boolean {
  if (!file) return false;
  const parts = file.split(/[\\/]/);
  return (
    parts[parts.length - 1] === 'S00E00.Trailer.mp4' &&
    parts[parts.length - 2] === 'Season 00'
  );
}

function isPlaceholderMedia(media: Media): boolean {
  return (
    !!media.Part?.length && media.Part.every((p) => isPlaceholderFile(p.file))
  );
}

function withoutPlaceholderMedia(media: Media[]): Media[] {
  return media.some(isPlaceholderMedia)
    ? media.filter((m) => !isPlaceholderMedia(m))
    : media;
}

export class PlexEpisodeMediaScanner implements EpisodeMediaScanner {
  trailerRatingKeys: string[] = [];

  constructor(private plexApi: PlexAPI) {}

  async scanLibraryEpisodes(
    libraryId: string,
    needsStreamDetail: boolean
  ): Promise<EpisodeMediaInfo[]> {
    const startTime = Date.now();

    const listed = await this.plexApi.getLibraryItemsByType(libraryId, 4);
    this.trailerRatingKeys = [];
    const episodes: PlexLibraryItem[] = [];
    for (const ep of listed) {
      const kept = ep.Media?.length ? withoutPlaceholderMedia(ep.Media) : [];
      if (ep.Media?.length && kept.length === 0) {
        this.trailerRatingKeys.push(ep.ratingKey);
      } else {
        episodes.push(
          kept.length === ep.Media?.length ? ep : { ...ep, Media: kept }
        );
      }
    }

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
        ? { ...ep, Media: withoutPlaceholderMedia(metadata.Media ?? []) }
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
    const bestIndex = bestMediaIndex(ep.Media);
    const media = ep.Media[bestIndex];
    const streams = media.Part?.[0]?.Stream;

    const caps = extractEpisodeCapabilities(media, streams);

    return {
      ratingKey: ep.ratingKey,
      showRatingKey: ep.grandparentRatingKey || '',
      seasonRatingKey: ep.parentRatingKey || '',
      seasonNumber: ep.parentIndex ?? 0,
      episodeNumber: ep.index ?? 0,
      ...caps,
      mediaHash: computeMediaHash(
        bestIndex === 0
          ? ep.Media
          : [{ bestMediaIndex: bestIndex }, ...ep.Media]
      ),
      versionCount: ep.Media.length,
      addedAt: ep.addedAt,
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

  const versions = withoutPlaceholderMedia(metadata.Media ?? []);
  const media = versions.length
    ? versions[bestMediaIndex(versions)]
    : undefined;
  const streams = media?.Part?.[0]?.Stream;

  if (media && streams && streams.length > 0) {
    return {
      ...lightweightEp,
      ...extractEpisodeCapabilities(media, streams),
      hasStreamDetail: true,
    };
  }

  return { ...lightweightEp, hasStreamDetail: true };
}

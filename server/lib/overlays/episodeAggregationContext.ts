import type { AggregatedMediaInfo } from './episodeMediaTypes';
import { daysSince } from './OverlayContextBuilder';
import type { OverlayRenderContext } from './OverlayTemplateRenderer';

export function buildEpisodeAggregationContext(
  itemType: string,
  ratingKey: string,
  baseContext: Partial<OverlayRenderContext>,
  aggregatedMap: Map<string, AggregatedMediaInfo> | undefined
): Partial<OverlayRenderContext> {
  let episodeAggregation: Partial<OverlayRenderContext> = {};
  if (itemType === 'show') {
    episodeAggregation.episodeMediaSource = 'show';
  }
  if (!aggregatedMap || (itemType !== 'show' && itemType !== 'season')) {
    return episodeAggregation;
  }
  const agg = aggregatedMap.get(ratingKey);
  if (!agg) return episodeAggregation;

  episodeAggregation = {
    ...(itemType === 'show'
      ? {
          showResolution: baseContext.resolution,
          showHdr: baseContext.hdr,
          showDolbyVision: baseContext.dolbyVision,
          showDolbyVisionProfile: baseContext.dolbyVisionProfile,
          showAudioCodec: baseContext.audioCodec,
          showAudioChannels: baseContext.audioChannels,
          showVideoCodec: baseContext.videoCodec,
          showBitDepth: baseContext.bitDepth,
        }
      : {}),
    resolution: agg.resolution,
    hdr: agg.hdr,
    dolbyVision: agg.dolbyVision,
    dolbyVisionProfile: agg.dolbyVisionProfile,
    hdr10Plus: agg.hdr10Plus,
    videoCodec: agg.videoCodec,
    audioCodec: agg.audioCodec,
    audioProfile: agg.audioProfile,
    audioChannels: agg.audioChannels,
    bitDepth: agg.bitDepth,
    episodeCount: agg.episodeCount,
    episode4kCount: agg.episode4kCount,
    episode4kPercent: agg.episode4kPercent,
    episodeHdrCount: agg.episodeHdrCount,
    episodeHdrPercent: agg.episodeHdrPercent,
    episodeDvCount: agg.episodeDvCount,
    episodeDvPercent: agg.episodeDvPercent,
    episodeMediaSource: 'aggregated',
  };
  if (agg.episodeMultiVersionCount !== undefined) {
    episodeAggregation.episodeMultiVersionCount = agg.episodeMultiVersionCount;
    episodeAggregation.hasMultipleVersions = agg.episodeMultiVersionCount > 0;
  }
  if (agg.lastEpisodeAddedAt !== undefined) {
    episodeAggregation.lastEpisodeAddedDate = new Date(
      agg.lastEpisodeAddedAt * 1000
    );
    episodeAggregation.daysSinceLastEpisodeAdded = daysSince(
      agg.lastEpisodeAddedAt
    );
  }
  return episodeAggregation;
}

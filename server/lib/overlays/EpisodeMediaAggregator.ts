import type {
  AggregatedMediaInfo,
  EpisodeMediaInfo,
} from './episodeMediaTypes';

const RESOLUTION_RANK: Record<string, number> = {
  '4k': 4,
  '1080': 3,
  '720': 2,
  '480': 1,
  sd: 0,
};

function resolutionRank(res: string): number {
  return RESOLUTION_RANK[res.toLowerCase()] ?? 0;
}

function majorityVote<T>(
  values: T[],
  rankFn?: (v: T) => number
): T | undefined {
  if (values.length === 0) return undefined;

  const counts = new Map<T, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) || 0) + 1);
  }

  let best: T | undefined;
  let bestCount = 0;

  for (const [value, count] of counts) {
    if (
      count > bestCount ||
      (count === bestCount &&
        rankFn &&
        best !== undefined &&
        rankFn(value) > rankFn(best))
    ) {
      best = value;
      bestCount = count;
    }
  }

  return best;
}

function booleanMajority(values: boolean[]): boolean {
  if (values.length === 0) return false;
  const trueCount = values.filter(Boolean).length;
  return trueCount >= values.length / 2;
}

function percent(count: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((count / total) * 100);
}

export class EpisodeMediaAggregator {
  aggregateByShow(
    episodes: EpisodeMediaInfo[]
  ): Map<string, AggregatedMediaInfo> {
    const byShow = new Map<string, EpisodeMediaInfo[]>();

    for (const ep of episodes) {
      if (!ep.showRatingKey) continue;
      const list = byShow.get(ep.showRatingKey) || [];
      list.push(ep);
      byShow.set(ep.showRatingKey, list);
    }

    const result = new Map<string, AggregatedMediaInfo>();

    for (const [showKey, showEpisodes] of byShow) {
      // Exclude Season 0 (specials) unless the show has ONLY specials
      const nonSpecials = showEpisodes.filter((ep) => ep.seasonNumber !== 0);
      const epsToAggregate =
        nonSpecials.length > 0 ? nonSpecials : showEpisodes;

      result.set(showKey, this.aggregate(epsToAggregate));
    }

    return result;
  }

  aggregateBySeason(
    episodes: EpisodeMediaInfo[]
  ): Map<string, AggregatedMediaInfo> {
    const bySeason = new Map<string, EpisodeMediaInfo[]>();

    for (const ep of episodes) {
      if (!ep.seasonRatingKey) continue;
      const list = bySeason.get(ep.seasonRatingKey) || [];
      list.push(ep);
      bySeason.set(ep.seasonRatingKey, list);
    }

    const result = new Map<string, AggregatedMediaInfo>();
    for (const [seasonKey, seasonEpisodes] of bySeason) {
      result.set(seasonKey, this.aggregate(seasonEpisodes));
    }
    return result;
  }

  private aggregate(episodes: EpisodeMediaInfo[]): AggregatedMediaInfo {
    if (episodes.length === 0) {
      return {
        resolution: 'sd',
        hdr: false,
        dolbyVision: false,
        videoCodec: '',
        audioCodec: '',
        audioChannels: 2,
        bitDepth: 8,
        episodeCount: 0,
        episode4kCount: 0,
        episode4kPercent: 0,
        episodeHdrCount: 0,
        episodeHdrPercent: 0,
        episodeDvCount: 0,
        episodeDvPercent: 0,
        episodeMediaSource: 'aggregated',
      };
    }

    const count = episodes.length;
    const fourKCount = episodes.filter(
      (ep) => ep.resolution.toLowerCase() === '4k'
    ).length;
    const hdrCount = episodes.filter((ep) => ep.hdr).length;
    const dvCount = episodes.filter((ep) => ep.dolbyVision).length;

    const dvEpisodes = episodes.filter((ep) => ep.dolbyVision);
    const dvProfiles = dvEpisodes
      .map((ep) => ep.dolbyVisionProfile)
      .filter((p): p is number => p !== undefined);

    return {
      resolution:
        majorityVote(
          episodes.map((ep) => ep.resolution),
          resolutionRank
        ) || 'sd',
      hdr: booleanMajority(episodes.map((ep) => ep.hdr)),
      dolbyVision: booleanMajority(episodes.map((ep) => ep.dolbyVision)),
      dolbyVisionProfile: majorityVote(dvProfiles),
      videoCodec:
        majorityVote(episodes.map((ep) => ep.videoCodec)) || '',
      audioCodec:
        majorityVote(episodes.map((ep) => ep.audioCodec)) || '',
      audioChannels:
        majorityVote(episodes.map((ep) => ep.audioChannels)) || 2,
      bitDepth: majorityVote(episodes.map((ep) => ep.bitDepth)) || 8,
      episodeCount: count,
      episode4kCount: fourKCount,
      episode4kPercent: percent(fourKCount, count),
      episodeHdrCount: hdrCount,
      episodeHdrPercent: percent(hdrCount, count),
      episodeDvCount: dvCount,
      episodeDvPercent: percent(dvCount, count),
      episodeMediaSource: 'aggregated',
    };
  }
}

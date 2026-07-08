import { describe, expect, it } from 'vitest';
import { EpisodeMediaAggregator } from './EpisodeMediaAggregator';
import type { EpisodeMediaInfo } from './episodeMediaTypes';

function makeEpisode(
  overrides: Partial<EpisodeMediaInfo> & { showRatingKey: string }
): EpisodeMediaInfo {
  return {
    ratingKey: `ep-${Math.random().toString(36).slice(2, 7)}`,
    seasonRatingKey: 'season-1',
    seasonNumber: 1,
    episodeNumber: 1,
    resolution: '1080',
    hdr: false,
    dolbyVision: false,
    videoCodec: 'h264',
    audioCodec: 'aac',
    audioChannels: 6,
    bitDepth: 8,
    mediaHash: 'abc123',
    hasStreamDetail: true,
    ...overrides,
  };
}

describe('EpisodeMediaAggregator', () => {
  const aggregator = new EpisodeMediaAggregator();

  describe('aggregateByShow', () => {
    it('returns empty map for no episodes', () => {
      const result = aggregator.aggregateByShow([]);
      expect(result.size).toBe(0);
    });

    it('handles single episode', () => {
      const episodes = [
        makeEpisode({
          showRatingKey: 'show-1',
          resolution: '4k',
          hdr: true,
          audioChannels: 8,
        }),
      ];
      const result = aggregator.aggregateByShow(episodes);
      const agg = result.get('show-1')!;
      expect(agg.resolution).toBe('4k');
      expect(agg.hdr).toBe(true);
      expect(agg.episodeCount).toBe(1);
      expect(agg.episode4kPercent).toBe(100);
      expect(agg.episodeMediaSource).toBe('aggregated');
    });

    it('uses majority vote for resolution', () => {
      const episodes = [
        makeEpisode({ showRatingKey: 'show-1', resolution: '4k' }),
        makeEpisode({ showRatingKey: 'show-1', resolution: '1080' }),
        makeEpisode({ showRatingKey: 'show-1', resolution: '1080' }),
      ];
      const result = aggregator.aggregateByShow(episodes);
      expect(result.get('show-1')!.resolution).toBe('1080');
    });

    it('breaks resolution ties to higher quality', () => {
      const episodes = [
        makeEpisode({ showRatingKey: 'show-1', resolution: '4k' }),
        makeEpisode({ showRatingKey: 'show-1', resolution: '1080' }),
      ];
      const result = aggregator.aggregateByShow(episodes);
      expect(result.get('show-1')!.resolution).toBe('4k');
    });

    it('uses majority for HDR boolean (50% threshold)', () => {
      const episodes = [
        makeEpisode({ showRatingKey: 'show-1', hdr: true }),
        makeEpisode({ showRatingKey: 'show-1', hdr: false }),
      ];
      const result = aggregator.aggregateByShow(episodes);
      // 50% = true (>= threshold)
      expect(result.get('show-1')!.hdr).toBe(true);
    });

    it('uses majority for DV boolean', () => {
      const episodes = [
        makeEpisode({ showRatingKey: 'show-1', dolbyVision: true }),
        makeEpisode({ showRatingKey: 'show-1', dolbyVision: false }),
        makeEpisode({ showRatingKey: 'show-1', dolbyVision: false }),
      ];
      const result = aggregator.aggregateByShow(episodes);
      expect(result.get('show-1')!.dolbyVision).toBe(false);
      expect(result.get('show-1')!.episodeDvPercent).toBe(33);
    });

    it('uses most common audio channels (not highest)', () => {
      const episodes = [
        makeEpisode({ showRatingKey: 'show-1', audioChannels: 6 }),
        makeEpisode({ showRatingKey: 'show-1', audioChannels: 6 }),
        makeEpisode({ showRatingKey: 'show-1', audioChannels: 8 }),
      ];
      const result = aggregator.aggregateByShow(episodes);
      expect(result.get('show-1')!.audioChannels).toBe(6);
    });

    it('excludes Season 0 from aggregation', () => {
      const episodes = [
        makeEpisode({
          showRatingKey: 'show-1',
          seasonNumber: 0,
          resolution: 'sd',
        }),
        makeEpisode({
          showRatingKey: 'show-1',
          seasonNumber: 1,
          resolution: '4k',
        }),
        makeEpisode({
          showRatingKey: 'show-1',
          seasonNumber: 1,
          resolution: '4k',
        }),
      ];
      const result = aggregator.aggregateByShow(episodes);
      const agg = result.get('show-1')!;
      expect(agg.resolution).toBe('4k');
      expect(agg.episodeCount).toBe(2);
    });

    it('includes specials if show has ONLY specials', () => {
      const episodes = [
        makeEpisode({
          showRatingKey: 'show-1',
          seasonNumber: 0,
          resolution: 'sd',
        }),
        makeEpisode({
          showRatingKey: 'show-1',
          seasonNumber: 0,
          resolution: '720',
        }),
      ];
      const result = aggregator.aggregateByShow(episodes);
      const agg = result.get('show-1')!;
      expect(agg.episodeCount).toBe(2);
    });

    it('handles all same values', () => {
      const episodes = Array.from({ length: 10 }, () =>
        makeEpisode({
          showRatingKey: 'show-1',
          resolution: '4k',
          hdr: true,
          dolbyVision: true,
        })
      );
      const result = aggregator.aggregateByShow(episodes);
      const agg = result.get('show-1')!;
      expect(agg.resolution).toBe('4k');
      expect(agg.episode4kPercent).toBe(100);
      expect(agg.episodeHdrPercent).toBe(100);
    });

    it('handles all different values', () => {
      const episodes = [
        makeEpisode({
          showRatingKey: 'show-1',
          resolution: '4k',
          videoCodec: 'hevc',
        }),
        makeEpisode({
          showRatingKey: 'show-1',
          resolution: '1080',
          videoCodec: 'h264',
        }),
        makeEpisode({
          showRatingKey: 'show-1',
          resolution: '720',
          videoCodec: 'av1',
        }),
      ];
      const result = aggregator.aggregateByShow(episodes);
      const agg = result.get('show-1')!;
      // Three-way tie breaks to highest quality
      expect(agg.resolution).toBe('4k');
      expect(agg.episodeCount).toBe(3);
    });

    it('groups by show correctly', () => {
      const episodes = [
        makeEpisode({ showRatingKey: 'show-1', resolution: '4k' }),
        makeEpisode({ showRatingKey: 'show-2', resolution: '1080' }),
        makeEpisode({ showRatingKey: 'show-1', resolution: '4k' }),
      ];
      const result = aggregator.aggregateByShow(episodes);
      expect(result.size).toBe(2);
      expect(result.get('show-1')!.episode4kPercent).toBe(100);
      expect(result.get('show-2')!.episode4kPercent).toBe(0);
    });

    it('calculates percentages correctly', () => {
      const episodes = [
        makeEpisode({
          showRatingKey: 'show-1',
          resolution: '4k',
          hdr: true,
          dolbyVision: true,
        }),
        makeEpisode({
          showRatingKey: 'show-1',
          resolution: '4k',
          hdr: true,
          dolbyVision: false,
        }),
        makeEpisode({
          showRatingKey: 'show-1',
          resolution: '1080',
          hdr: false,
          dolbyVision: false,
        }),
      ];
      const result = aggregator.aggregateByShow(episodes);
      const agg = result.get('show-1')!;
      expect(agg.episode4kCount).toBe(2);
      expect(agg.episode4kPercent).toBe(67);
      expect(agg.episodeHdrCount).toBe(2);
      expect(agg.episodeHdrPercent).toBe(67);
      expect(agg.episodeDvCount).toBe(1);
      expect(agg.episodeDvPercent).toBe(33);
    });
  });

  describe('aggregateBySeason', () => {
    it('groups by season correctly', () => {
      const episodes = [
        makeEpisode({
          showRatingKey: 'show-1',
          seasonRatingKey: 's1',
          resolution: '4k',
        }),
        makeEpisode({
          showRatingKey: 'show-1',
          seasonRatingKey: 's2',
          resolution: '1080',
        }),
        makeEpisode({
          showRatingKey: 'show-1',
          seasonRatingKey: 's1',
          resolution: '4k',
        }),
      ];
      const result = aggregator.aggregateBySeason(episodes);
      expect(result.size).toBe(2);
      expect(result.get('s1')!.resolution).toBe('4k');
      expect(result.get('s2')!.resolution).toBe('1080');
    });
  });
});

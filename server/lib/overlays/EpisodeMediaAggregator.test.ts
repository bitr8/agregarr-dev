import { describe, expect, it } from 'vitest';
import {
  EpisodeMediaAggregator,
  mergedAddedAt,
  mergedVersionCount,
  needsAddedAtResave,
  needsVersionCountResave,
  newestEpisodeAddedAtByShow,
} from './EpisodeMediaAggregator';
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
    hdr10Plus: false,
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

  describe('newestEpisodeAddedAtByShow', () => {
    it('returns per-show max addedAt, ignoring episodes with no addedAt', () => {
      const episodes = [
        makeEpisode({ showRatingKey: 'show-1', addedAt: 1000 }),
        makeEpisode({ showRatingKey: 'show-1', addedAt: 2000 }),
        makeEpisode({ showRatingKey: 'show-2', addedAt: 500 }),
      ];
      const result = newestEpisodeAddedAtByShow(episodes);
      expect(result.get('show-1')).toBe(2000);
      expect(result.get('show-2')).toBe(500);
    });

    it('omits a show entirely when none of its episodes have addedAt', () => {
      const episodes = [
        makeEpisode({ showRatingKey: 'show-1' }),
        makeEpisode({ showRatingKey: 'show-1' }),
      ];
      const result = newestEpisodeAddedAtByShow(episodes);
      expect(result.has('show-1')).toBe(false);
    });

    it('treats addedAt 0 as absent, not a valid max', () => {
      const episodes = [
        makeEpisode({ showRatingKey: 'show-1', addedAt: 0 }),
        makeEpisode({ showRatingKey: 'show-2', addedAt: 0 }),
        makeEpisode({ showRatingKey: 'show-2', addedAt: 1000 }),
      ];
      const result = newestEpisodeAddedAtByShow(episodes);
      expect(result.has('show-1')).toBe(false);
      expect(result.get('show-2')).toBe(1000);
    });
  });

  describe('mergedAddedAt', () => {
    it('prefers the fresh value when present', () => {
      const freshAddedAtByKey = new Map([['ep-1', 2000]]);
      expect(mergedAddedAt('ep-1', 1000, freshAddedAtByKey)).toBe(2000);
    });

    it('keeps the previous value when the fresh scan omits addedAt', () => {
      const freshAddedAtByKey = new Map<string, number | undefined>([
        ['ep-1', undefined],
      ]);
      expect(mergedAddedAt('ep-1', 100, freshAddedAtByKey)).toBe(100);
    });

    it('is null when neither fresh nor previous has a value', () => {
      const freshAddedAtByKey = new Map<string, number | undefined>();
      expect(mergedAddedAt('ep-1', undefined, freshAddedAtByKey)).toBeNull();
    });
  });

  describe('needsAddedAtResave', () => {
    it('is true when the value changed (cached 100, merged 200)', () => {
      const cachedEpisodes = [
        makeEpisode({
          ratingKey: 'ep-1',
          showRatingKey: 'show-1',
          addedAt: 100,
        }),
      ];
      const mergedAddedAtByKey = new Map([['ep-1', 200]]);
      expect(
        needsAddedAtResave(
          cachedEpisodes,
          mergedAddedAtByKey,
          new Set(['ep-1'])
        )
      ).toBe(true);
    });

    it('is false when both cached and merged are unknown', () => {
      const cachedEpisodes = [
        makeEpisode({ ratingKey: 'ep-1', showRatingKey: 'show-1' }),
      ];
      const mergedAddedAtByKey = new Map<string, number | undefined>([
        ['ep-1', undefined],
      ]);
      expect(
        needsAddedAtResave(
          cachedEpisodes,
          mergedAddedAtByKey,
          new Set(['ep-1'])
        )
      ).toBe(false);
    });

    it('is true when a known value is removed (cached 100, merged absent)', () => {
      const cachedEpisodes = [
        makeEpisode({
          ratingKey: 'ep-1',
          showRatingKey: 'show-1',
          addedAt: 100,
        }),
      ];
      const mergedAddedAtByKey = new Map<string, number | undefined>([
        ['ep-1', undefined],
      ]);
      expect(
        needsAddedAtResave(
          cachedEpisodes,
          mergedAddedAtByKey,
          new Set(['ep-1'])
        )
      ).toBe(true);
    });

    it('is false when the value is identical', () => {
      const cachedEpisodes = [
        makeEpisode({
          ratingKey: 'ep-1',
          showRatingKey: 'show-1',
          addedAt: 100,
        }),
      ];
      const mergedAddedAtByKey = new Map([['ep-1', 100]]);
      expect(
        needsAddedAtResave(
          cachedEpisodes,
          mergedAddedAtByKey,
          new Set(['ep-1'])
        )
      ).toBe(false);
    });

    it('ignores a cached row whose ratingKey is not in currentKeys', () => {
      const cachedEpisodes = [
        makeEpisode({
          ratingKey: 'ep-1',
          showRatingKey: 'show-1',
          addedAt: 100,
        }),
      ];
      const mergedAddedAtByKey = new Map([['ep-1', 999]]);
      expect(
        needsAddedAtResave(cachedEpisodes, mergedAddedAtByKey, new Set())
      ).toBe(false);
    });

    it('reflects mergedAddedAt: omission-preserved value is not a change', () => {
      const cached = makeEpisode({
        ratingKey: 'ep-1',
        showRatingKey: 'show-1',
        addedAt: 100,
      });
      const freshAddedAtByKey = new Map<string, number | undefined>([
        ['ep-1', undefined],
      ]);
      const merged = mergedAddedAt('ep-1', cached.addedAt, freshAddedAtByKey);
      expect(merged).toBe(100);
      expect(
        needsAddedAtResave(
          [cached],
          new Map([['ep-1', merged]]),
          new Set(['ep-1'])
        )
      ).toBe(false);
    });
  });

  describe('aggregateByShow: lastEpisodeAddedAt', () => {
    it('sets the per-show max addedAt on the aggregate', () => {
      const episodes = [
        makeEpisode({ showRatingKey: 'show-1', addedAt: 1000 }),
        makeEpisode({ showRatingKey: 'show-1', addedAt: 4000 }),
        makeEpisode({ showRatingKey: 'show-2', addedAt: 2000 }),
      ];
      const result = aggregator.aggregateByShow(episodes);
      expect(result.get('show-1')!.lastEpisodeAddedAt).toBe(4000);
      expect(result.get('show-2')!.lastEpisodeAddedAt).toBe(2000);
    });

    it('ignores addedAt 0 when picking the max', () => {
      const episodes = [
        makeEpisode({ showRatingKey: 'show-1', addedAt: 0 }),
        makeEpisode({ showRatingKey: 'show-1', addedAt: 500 }),
      ];
      const result = aggregator.aggregateByShow(episodes);
      expect(result.get('show-1')!.lastEpisodeAddedAt).toBe(500);
    });

    it('leaves lastEpisodeAddedAt unset when no episode has addedAt', () => {
      const episodes = [makeEpisode({ showRatingKey: 'show-1' })];
      const result = aggregator.aggregateByShow(episodes);
      expect(result.get('show-1')!.lastEpisodeAddedAt).toBeUndefined();
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

  describe('aggregateByShowAndSeason', () => {
    it('keys each season by its own episodes, not the show majority', () => {
      const episodes = [
        makeEpisode({
          showRatingKey: 'show-1',
          seasonRatingKey: 's1',
          resolution: '1080',
          audioProfile: 'plus',
        }),
        makeEpisode({
          showRatingKey: 'show-1',
          seasonRatingKey: 's2',
          resolution: '4k',
          audioProfile: 'truehd_atmos',
          hdr10Plus: true,
        }),
        makeEpisode({
          showRatingKey: 'show-1',
          seasonRatingKey: 's2',
          resolution: '4k',
          audioProfile: 'truehd_atmos',
          hdr10Plus: true,
        }),
      ];
      const result = aggregator.aggregateByShowAndSeason(episodes);
      expect([...result.keys()].sort()).toEqual(['s1', 's2', 'show-1']);
      expect(result.get('show-1')!.resolution).toBe('4k');
      expect(result.get('s1')).toMatchObject({
        resolution: '1080',
        audioProfile: 'plus',
        hdr10Plus: false,
        episodeCount: 1,
      });
      expect(result.get('s2')).toMatchObject({
        resolution: '4k',
        audioProfile: 'truehd_atmos',
        hdr10Plus: true,
        episodeCount: 2,
      });
    });
  });
});

describe('multi-version episode counts', () => {
  const aggregator = new EpisodeMediaAggregator();
  const ep = (
    ratingKey: string,
    seasonNumber: number,
    versionCount: number | null | undefined
  ) =>
    makeEpisode({
      ratingKey,
      showRatingKey: 'show-1',
      seasonRatingKey: `season-${seasonNumber}`,
      seasonNumber,
      versionCount,
    });

  it('counts episodes with more than one version per show and season', () => {
    const result = aggregator.aggregateByShowAndSeason([
      ep('a', 1, 2),
      ep('b', 1, 1),
      ep('c', 2, 1),
      ep('d', 2, 1),
    ]);
    expect(result.get('show-1')?.episodeMultiVersionCount).toBe(1);
    expect(result.get('season-1')?.episodeMultiVersionCount).toBe(1);
    expect(result.get('season-2')?.episodeMultiVersionCount).toBe(0);
  });

  it('leaves the count unset when no episode has a known value', () => {
    const result = aggregator.aggregateByShowAndSeason([
      ep('a', 1, null),
      ep('b', 1, undefined),
    ]);
    expect(result.get('show-1')?.episodeMultiVersionCount).toBeUndefined();
    expect(result.get('season-1')?.episodeMultiVersionCount).toBeUndefined();
  });

  it('counts only the episodes whose value is known', () => {
    const result = aggregator.aggregateByShowAndSeason([
      ep('a', 1, null),
      ep('b', 1, 3),
    ]);
    expect(result.get('show-1')?.episodeMultiVersionCount).toBe(1);
  });

  it('keeps specials out of the show and season rollups', () => {
    const result = aggregator.aggregateByShowAndSeason([
      ep('s1', 0, 2),
      ep('a', 1, 1),
    ]);
    expect(result.get('show-1')?.episodeMultiVersionCount).toBe(0);
    expect(result.get('season-0')?.episodeMultiVersionCount).toBeUndefined();
    expect(result.get('season-1')?.episodeMultiVersionCount).toBe(0);
  });

  it('does not badge a show that has only specials', () => {
    const result = aggregator.aggregateByShowAndSeason([ep('s1', 0, 2)]);
    expect(result.get('show-1')?.episodeMultiVersionCount).toBeUndefined();
  });

  describe('merge helpers', () => {
    it('fresh value wins, an omitted one keeps the previous', () => {
      expect(mergedVersionCount('a', null, new Map([['a', 2]]))).toBe(2);
      expect(mergedVersionCount('a', 3, new Map())).toBe(3);
      expect(mergedVersionCount('a', undefined, new Map())).toBeNull();
    });

    it('asks for a resave when a cached row has no count but the merge does', () => {
      const cached = [ep('a', 1, null), ep('b', 1, 1)];
      const merged = new Map<string, number | null>([
        ['a', 2],
        ['b', 1],
      ]);
      expect(needsVersionCountResave(cached, merged, new Set(['a', 'b']))).toBe(
        true
      );
    });

    it('does not resave when cache and merge agree, or the row is gone', () => {
      const cached = [ep('a', 1, 2), ep('gone', 1, null)];
      const merged = new Map<string, number | null>([['a', 2]]);
      expect(needsVersionCountResave(cached, merged, new Set(['a']))).toBe(
        false
      );
    });
  });
});

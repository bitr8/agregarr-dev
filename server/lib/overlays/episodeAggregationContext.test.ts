import { describe, expect, it } from 'vitest';
import { buildEpisodeAggregationContext } from './episodeAggregationContext';
import type { AggregatedMediaInfo } from './episodeMediaTypes';

const agg: AggregatedMediaInfo = {
  resolution: '4k',
  hdr: true,
  dolbyVision: false,
  hdr10Plus: false,
  videoCodec: 'hevc',
  audioCodec: 'eac3',
  audioChannels: 6,
  bitDepth: 10,
  episodeCount: 20,
  episode4kCount: 10,
  episode4kPercent: 50,
  episodeHdCount: 6,
  episodeHdPercent: 30,
  episodeSdCount: 3,
  episodeSdPercent: 15,
  episodeUnknownResolutionCount: 1,
  episodeHdrCount: 20,
  episodeHdrPercent: 100,
  episodeDvCount: 0,
  episodeDvPercent: 0,
  episodeMediaSource: 'aggregated',
};
const map = new Map([['100', agg]]);
const base = { resolution: '1080', hdr: false, audioChannels: 2 };

describe('buildEpisodeAggregationContext', () => {
  it('overlays aggregated quality and keeps the show-level values for a show', () => {
    const ctx = buildEpisodeAggregationContext('show', '100', base, map);
    expect(ctx.resolution).toBe('4k');
    expect(ctx.showResolution).toBe('1080');
    expect(ctx.episode4kPercent).toBe(50);
    expect(ctx.episodeMediaSource).toBe('aggregated');
  });

  it('passes the HD, SD and unknown resolution counts through', () => {
    const ctx = buildEpisodeAggregationContext('season', '100', base, map);
    expect(ctx.episodeHdCount).toBe(6);
    expect(ctx.episodeHdPercent).toBe(30);
    expect(ctx.episodeSdCount).toBe(3);
    expect(ctx.episodeSdPercent).toBe(15);
    expect(ctx.episodeUnknownResolutionCount).toBe(1);
  });

  it('skips the show-prefixed fields for a season', () => {
    const ctx = buildEpisodeAggregationContext('season', '100', base, map);
    expect(ctx.resolution).toBe('4k');
    expect(ctx).not.toHaveProperty('showResolution');
  });

  it('marks a show with no aggregation as show-sourced', () => {
    expect(buildEpisodeAggregationContext('show', '999', base, map)).toEqual({
      episodeMediaSource: 'show',
    });
    expect(
      buildEpisodeAggregationContext('show', '100', base, undefined)
    ).toEqual({ episodeMediaSource: 'show' });
  });

  it('adds nothing for a movie', () => {
    expect(buildEpisodeAggregationContext('movie', '100', base, map)).toEqual(
      {}
    );
  });

  it('derives last-episode-added fields from the unix timestamp', () => {
    const at = Math.floor(Date.now() / 1000) - 3 * 86400;
    const ctx = buildEpisodeAggregationContext(
      'show',
      '100',
      base,
      new Map([['100', { ...agg, lastEpisodeAddedAt: at }]])
    );
    expect(ctx.lastEpisodeAddedDate).toEqual(new Date(at * 1000));
    expect(ctx.daysSinceLastEpisodeAdded).toBe(3);
  });
});

describe('buildEpisodeAggregationContext multi-version', () => {
  const withCount = (count: number | undefined): AggregatedMediaInfo => ({
    ...agg,
    episodeMultiVersionCount: count,
  });

  it('flags a show or season that holds a multi-version episode', () => {
    const m = new Map([['100', withCount(2)]]);
    for (const type of ['show', 'season']) {
      const ctx = buildEpisodeAggregationContext(type, '100', base, m);
      expect(ctx.episodeMultiVersionCount).toBe(2);
      expect(ctx.hasMultipleVersions).toBe(true);
    }
  });

  it('is a plain no when the count is zero', () => {
    const ctx = buildEpisodeAggregationContext(
      'season',
      '100',
      base,
      new Map([['100', withCount(0)]])
    );
    expect(ctx.episodeMultiVersionCount).toBe(0);
    expect(ctx.hasMultipleVersions).toBe(false);
  });

  it('sets neither when the count is unknown', () => {
    const ctx = buildEpisodeAggregationContext(
      'show',
      '100',
      base,
      new Map([['100', withCount(undefined)]])
    );
    expect(ctx).not.toHaveProperty('episodeMultiVersionCount');
    expect(ctx).not.toHaveProperty('hasMultipleVersions');
  });
});

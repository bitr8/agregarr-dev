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

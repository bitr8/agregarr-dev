import { describe, expect, it } from 'vitest';
import {
  EpisodeMediaAggregator,
  mergedResolution,
  needsResolutionResave,
} from './EpisodeMediaAggregator';
import type { EpisodeMediaInfo } from './episodeMediaTypes';

function makeEpisode(overrides: Partial<EpisodeMediaInfo>): EpisodeMediaInfo {
  return {
    ratingKey: 'ep-1',
    showRatingKey: 'show-1',
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

describe('EpisodeMediaAggregator resolution buckets', () => {
  const aggregator = new EpisodeMediaAggregator();
  const show = (resolutions: string[]) =>
    aggregator
      .aggregateByShow(
        resolutions.map((resolution, i) =>
          makeEpisode({ ratingKey: `ep-${i}`, resolution })
        )
      )
      .get('show-1')!;

  it('splits episodes into non-overlapping buckets that sum to the episode count', () => {
    const agg = show([
      '4k',
      '2k',
      '1080',
      '720',
      '576',
      '480',
      'sd',
      '360',
      'unknown',
      'weird',
    ]);
    expect(agg.episode4kCount).toBe(1);
    expect(agg.episodeHdCount).toBe(3);
    expect(agg.episodeSdCount).toBe(4);
    expect(agg.episodeUnknownResolutionCount).toBe(2);
    expect(
      agg.episode4kCount +
        agg.episodeHdCount +
        agg.episodeSdCount +
        agg.episodeUnknownResolutionCount
    ).toBe(agg.episodeCount);
    expect(agg.episodeHdPercent).toBe(30);
    expect(agg.episodeSdPercent).toBe(40);
  });

  it('counts 2k as HD', () => {
    const agg = show(['2k']);
    expect(agg.episodeHdCount).toBe(1);
    expect(agg.episodeUnknownResolutionCount).toBe(0);
  });

  it('keeps the representative resolution when unknown episodes are present', () => {
    expect(show(['unknown', 'unknown', '1080']).resolution).toBe('sd');
    expect(show(['unknown', 'unknown', 'sd']).resolution).toBe('sd');
    expect(show(['unknown', '1080', '1080']).resolution).toBe('1080');
  });

  it('applies to seasons as well as shows', () => {
    const result = aggregator.aggregateBySeason([
      makeEpisode({ ratingKey: 'a', resolution: '720' }),
      makeEpisode({ ratingKey: 'b', resolution: 'unknown' }),
    ]);
    expect(result.get('season-1')!.episodeHdCount).toBe(1);
    expect(result.get('season-1')!.episodeUnknownResolutionCount).toBe(1);
  });
});

describe('resolution resave helpers', () => {
  const cached = [makeEpisode({ ratingKey: 'a' })];

  it('prefers the fresh resolution and falls back to the previous one', () => {
    expect(mergedResolution('a', 'sd', new Map([['a', '720']]))).toBe('720');
    expect(mergedResolution('a', 'sd', new Map())).toBe('sd');
  });

  it('never lets unknown replace a known value', () => {
    const unknown = new Map([['a', 'unknown']]);
    expect(mergedResolution('a', '1080', unknown)).toBe('1080');
    expect(mergedResolution('a', 'sd', unknown)).toBe('sd');
    expect(mergedResolution('a', 'unknown', unknown)).toBe('unknown');
  });

  it('flags a still-current row whose resolution changed', () => {
    const keys = new Set(['a']);
    expect(
      needsResolutionResave(cached, new Map([['a', 'unknown']]), keys)
    ).toBe(true);
    expect(needsResolutionResave(cached, new Map([['a', '1080']]), keys)).toBe(
      false
    );
    expect(
      needsResolutionResave(cached, new Map([['a', 'unknown']]), new Set())
    ).toBe(false);
  });
});

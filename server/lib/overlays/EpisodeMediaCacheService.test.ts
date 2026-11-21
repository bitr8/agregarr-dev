import { describe, expect, it } from 'vitest';
import { keepCachedDetail } from './EpisodeMediaCacheService';
import type { EpisodeMediaInfo } from './episodeMediaTypes';

const ep = (
  ratingKey: string,
  o: Partial<EpisodeMediaInfo> = {}
): EpisodeMediaInfo => ({
  ratingKey,
  showRatingKey: 's',
  seasonRatingKey: 'se',
  seasonNumber: 1,
  episodeNumber: 1,
  resolution: '1080',
  hdr: false,
  dolbyVision: false,
  hdr10Plus: false,
  videoCodec: 'h264',
  audioCodec: 'aac',
  audioChannels: 2,
  bitDepth: 8,
  mediaHash: 'h',
  hasStreamDetail: false,
  ...o,
});

describe('keepCachedDetail', () => {
  it('keeps cached stream detail for unchanged episodes, lightweight for stale', () => {
    const cachedA = ep('a', { hdr: true, bitDepth: 10, hasStreamDetail: true });
    const cachedB = ep('b', { hasStreamDetail: true, mediaHash: 'old' });
    const fresh = [ep('a'), ep('b', { mediaHash: 'new' }), ep('c')];
    const out = keepCachedDetail(
      fresh,
      new Map([
        ['a', cachedA],
        ['b', cachedB],
      ]),
      new Set(['b', 'c'])
    );
    expect(out[0]).toBe(cachedA);
    expect(out[1]).toBe(fresh[1]);
    expect(out[1].hasStreamDetail).toBe(false);
    expect(out[2]).toBe(fresh[2]);
  });
});

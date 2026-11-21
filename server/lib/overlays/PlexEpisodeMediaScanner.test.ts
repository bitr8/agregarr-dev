import type PlexAPI from '@server/api/plexapi';
import type { PlexMetadata } from '@server/api/plexapi';
import { describe, expect, it } from 'vitest';
import type { EpisodeMediaInfo } from './episodeMediaTypes';
import {
  PlexEpisodeMediaScanner,
  resolveFetchedEpisodeDetail,
} from './PlexEpisodeMediaScanner';

function lightweightEpisode(
  overrides: Partial<EpisodeMediaInfo> = {}
): EpisodeMediaInfo {
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
    videoCodec: '',
    audioCodec: '',
    audioChannels: 2,
    bitDepth: 8,
    mediaHash: 'hash-1',
    hasStreamDetail: false,
    ...overrides,
  };
}

// Minimal PlexMetadata shapes; cast because the tests only exercise the media
// path that resolveFetchedEpisodeDetail / extractMediaCapabilities read.
function metadata(mediaOverride: unknown): PlexMetadata {
  return { Media: mediaOverride } as unknown as PlexMetadata;
}

describe('resolveFetchedEpisodeDetail', () => {
  it('leaves the row lightweight (hasStreamDetail:false) when the fetch dropped it', () => {
    const ep = lightweightEpisode();
    const result = resolveFetchedEpisodeDetail(ep, undefined);
    expect(result.hasStreamDetail).toBe(false);
    expect(result).toEqual(ep);
  });

  it('extracts real capabilities and marks detail-fetched when a usable stream is present', () => {
    const ep = lightweightEpisode({ resolution: 'sd' });
    const result = resolveFetchedEpisodeDetail(
      ep,
      metadata([
        {
          videoResolution: '4k',
          Part: [
            {
              Stream: [{ streamType: 1, colorTrc: 'smpte2084', bitDepth: 10 }],
            },
          ],
        },
      ])
    );
    expect(result.hasStreamDetail).toBe(true);
    expect(result.resolution).toBe('4k');
    expect(result.hdr).toBe(true);
    expect(result.bitDepth).toBe(10);
  });

  it('marks an empty-stream response detail-fetched but keeps lightweight caps (converges, no re-poison)', () => {
    const ep = lightweightEpisode({ resolution: '1080', hdr: false });
    const result = resolveFetchedEpisodeDetail(
      ep,
      metadata([{ videoResolution: '4k', Part: [{ Stream: [] }] }])
    );
    // The empty stream must NOT be treated as detailed data...
    expect(result.hdr).toBe(false);
    expect(result.resolution).toBe('1080');
    // ...but it counts as fetched so it isn't re-fetched on every scan.
    expect(result.hasStreamDetail).toBe(true);
  });

  it('marks a response with no Media detail-fetched without crashing', () => {
    const ep = lightweightEpisode();
    const result = resolveFetchedEpisodeDetail(ep, metadata(undefined));
    expect(result.hasStreamDetail).toBe(true);
    expect(result.resolution).toBe(ep.resolution);
  });
});

describe('PlexEpisodeMediaScanner version count', () => {
  const listed = (ratingKey: string, mediaCount: number) => ({
    ratingKey,
    grandparentRatingKey: 'show-1',
    parentRatingKey: 'season-1',
    parentIndex: 1,
    index: 1,
    addedAt: 1,
    Media: Array.from({ length: mediaCount }, (_, i) => ({
      videoResolution: '1080',
      Part: [{ file: `/tv/ep-${i}.mkv` }],
    })),
  });
  const scannerFor = (items: unknown[]) =>
    new PlexEpisodeMediaScanner({
      getLibraryItemsByType: async () => items,
    } as unknown as PlexAPI);

  it('counts every listed version from the lightweight scan', async () => {
    const result = await scannerFor([
      listed('ep-1', 2),
      listed('ep-2', 1),
    ]).scanLibraryEpisodes('lib', false);
    expect(result.map((e) => [e.ratingKey, e.versionCount])).toEqual([
      ['ep-1', 2],
      ['ep-2', 1],
    ]);
    expect(result.every((e) => !e.hasStreamDetail)).toBe(true);
  });

  it('keeps the count when stream detail is applied', () => {
    const ep = lightweightEpisode({ versionCount: 2 });
    const result = resolveFetchedEpisodeDetail(
      ep,
      metadata([
        {
          videoResolution: '4k',
          Part: [{ Stream: [{ streamType: 1, bitDepth: 10 }] }],
        },
      ])
    );
    expect(result.versionCount).toBe(2);
  });
});

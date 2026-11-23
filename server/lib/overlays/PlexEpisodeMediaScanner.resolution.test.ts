import type PlexAPI from '@server/api/plexapi';
import type { PlexMetadata } from '@server/api/plexapi';
import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import type { EpisodeMediaInfo } from './episodeMediaTypes';
import { bestVersionRank, resolutionBucket } from './episodeResolution';
import {
  PlexEpisodeMediaScanner,
  resolveFetchedEpisodeDetail,
} from './PlexEpisodeMediaScanner';

const hashOf = (media: unknown[]) =>
  createHash('sha256').update(JSON.stringify(media)).digest('hex').slice(0, 16);

const version = (videoResolution: string | undefined, file = '/tv/ep.mkv') => ({
  ...(videoResolution === undefined ? {} : { videoResolution }),
  Part: [{ file }],
});

const listed = (ratingKey: string, Media: unknown[]) => ({
  ratingKey,
  grandparentRatingKey: 'show-1',
  parentRatingKey: 'season-1',
  parentIndex: 1,
  index: 1,
  addedAt: 1,
  Media,
});

const scannerFor = (items: unknown[], batch = new Map()) =>
  new PlexEpisodeMediaScanner({
    getLibraryItemsByType: async () => items,
    getMetadataBatch: async () => batch,
  } as unknown as PlexAPI);

describe('PlexEpisodeMediaScanner best version', () => {
  it('reads resolution from the highest-resolution entry, not the first', async () => {
    const [ep] = await scannerFor([
      listed('a', [version('720'), version('4k'), version('1080')]),
    ]).scanLibraryEpisodes('lib', false);
    expect(ep.resolution).toBe('4k');
  });

  it('ranks 2k above 1080 and 1080 above SD, and keeps the first on a tie', async () => {
    const scan = async (...res: string[]) =>
      (
        await scannerFor([
          listed(
            'a',
            res.map((r, i) => ({
              ...version(r),
              videoCodec: `codec-${i}`,
            }))
          ),
        ]).scanLibraryEpisodes('lib', false)
      )[0];
    expect((await scan('1080', '2k')).resolution).toBe('2k');
    expect((await scan('sd', '1080')).resolution).toBe('1080');
    expect((await scan('480', 'sd')).videoCodec).toBe('codec-0');
    expect((await scan('1080', '1080')).videoCodec).toBe('codec-0');
  });

  it('keeps mediaHash identical to the hash of the whole Media array when the best entry is first', async () => {
    const single = [version('1080')];
    const multi = [version('4k'), version('720', '/tv/ep2.mkv')];
    const results = await scannerFor([
      listed('a', single),
      listed('b', multi),
    ]).scanLibraryEpisodes('lib', false);
    expect(results[0].mediaHash).toBe(hashOf(single));
    expect(results[1].mediaHash).toBe(hashOf(multi));
  });

  it('changes mediaHash when the best entry is not the first, so the row is re-read', async () => {
    const media = [version('720'), version('4k', '/tv/ep2.mkv')];
    const [ep] = await scannerFor([listed('a', media)]).scanLibraryEpisodes(
      'lib',
      false
    );
    expect(ep.mediaHash).not.toBe(hashOf(media));
  });

  it('reads the best entry in the stream-detail pass too', () => {
    const base = { resolution: 'sd' } as EpisodeMediaInfo;
    const result = resolveFetchedEpisodeDetail(base, {
      Media: [
        {
          videoResolution: '720',
          Part: [{ Stream: [{ streamType: 1, bitDepth: 8 }] }],
        },
        {
          videoResolution: '4k',
          Part: [{ Stream: [{ streamType: 1, bitDepth: 10 }] }],
        },
      ],
    } as unknown as PlexMetadata);
    expect(result.resolution).toBe('4k');
    expect(result.bitDepth).toBe(10);
  });
});

describe('PlexEpisodeMediaScanner unknown resolution', () => {
  it('records unknown when Plex reports no videoResolution', async () => {
    const [ep] = await scannerFor([
      listed('a', [version(undefined)]),
    ]).scanLibraryEpisodes('lib', false);
    expect(ep.resolution).toBe('unknown');
  });

  it('records unknown in the stream-detail pass too', () => {
    const result = resolveFetchedEpisodeDetail(
      { resolution: 'unknown' } as EpisodeMediaInfo,
      {
        Media: [{ Part: [{ Stream: [{ streamType: 1, bitDepth: 10 }] }] }],
      } as unknown as PlexMetadata
    );
    expect(result.resolution).toBe('unknown');
    expect(result.hasStreamDetail).toBe(true);
  });
});

describe('PlexEpisodeMediaScanner trailer placeholders', () => {
  const placeholderPath = '/tv/Show (2026)/Season 00/S00E00.Trailer.mp4';
  const trailer = listed('t', [version('1080', placeholderPath)]);
  const real = listed('r', [version('1080', '/tv/Show/Season 01/S01E01.mkv')]);
  const realSpecial = listed('s', [
    version('1080', '/tv/Show/Season 00/Show - S00E00 - Trailer.mkv'),
  ]);

  it('drops the Agregarr placeholder and reports its rating key', async () => {
    const scanner = scannerFor([trailer, real, realSpecial]);
    const result = await scanner.scanLibraryEpisodes('lib', false);
    expect(result.map((e) => e.ratingKey)).toEqual(['r', 's']);
    expect(scanner.trailerRatingKeys).toEqual(['t']);
  });

  it('handles Windows separators', async () => {
    const scanner = scannerFor([
      listed('w', [
        version('1080', 'D:\\tv\\Show (2026)\\Season 00\\S00E00.Trailer.mp4'),
      ]),
    ]);
    expect(await scanner.scanLibraryEpisodes('lib', false)).toEqual([]);
    expect(scanner.trailerRatingKeys).toEqual(['w']);
  });

  it('requires the exact name, case and Season 00 folder', async () => {
    const lookalikes = [
      '/tv/Show/Season 01/S00E00.Trailer.mp4',
      '/tv/Show/Season 00/s00e00.trailer.mp4',
      '/tv/Show/Season 00/S00E00.Trailer.mkv',
      '/tv/S00E00.Trailer.mp4',
    ].map((f, i) => listed(`l${i}`, [version('1080', f)]));
    const scanner = scannerFor(lookalikes);
    const result = await scanner.scanLibraryEpisodes('lib', false);
    expect(result).toHaveLength(4);
    expect(scanner.trailerRatingKeys).toEqual([]);
  });

  it('never requests stream detail for them', async () => {
    const asked: string[][] = [];
    const scanner = new PlexEpisodeMediaScanner({
      getLibraryItemsByType: async () => [trailer, real],
      getMetadataBatch: async (keys: string[]) => {
        asked.push(keys);
        return new Map();
      },
    } as unknown as PlexAPI);
    const result = await scanner.scanLibraryEpisodes('lib', true);
    expect(asked).toEqual([['r']]);
    expect(result.map((e) => e.ratingKey)).toEqual(['r']);
  });
});

describe('best-version rank', () => {
  it('ranks 576 above 480 and any 4K-or-higher value like 4k', () => {
    expect(bestVersionRank('576')).toBeGreaterThan(bestVersionRank('480'));
    expect(bestVersionRank('480')).toBe(bestVersionRank('sd'));
    for (const r of ['8k', '4K', '2160', '4320']) {
      expect(bestVersionRank(r)).toBeGreaterThanOrEqual(bestVersionRank('4k'));
    }
    expect(bestVersionRank('2k')).toBeLessThan(bestVersionRank('4k'));
    expect(resolutionBucket('8k')).toBe('unknown');
  });
});

import type PlexAPI from '@server/api/plexapi';
import type { PlexMetadata } from '@server/api/plexapi';
import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import type { EpisodeMediaInfo } from './episodeMediaTypes';
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
  const trailer = listed('t', [
    version('1080', '/tv/Show (2020)/Season 00/Show - S00E00 - Trailer.mkv'),
  ]);
  const real = listed('r', [version('1080', '/tv/Show/Season 01/S01E01.mkv')]);
  const specialNamedTrailer = listed('s', [
    version('1080', '/tv/Show/Season 00/Show - S00E01 - Trailer.mkv'),
  ]);

  it('drops trailer placeholders from the lightweight scan', async () => {
    const result = await scannerFor([
      trailer,
      real,
      specialNamedTrailer,
    ]).scanLibraryEpisodes('lib', false);
    expect(result.map((e) => e.ratingKey)).toEqual(['r', 's']);
  });

  it('matches on the file name, not the folder', async () => {
    const result = await scannerFor([
      listed('x', [version('1080', '/tv/S00E00 Trailer/Show - S01E02.mkv')]),
    ]).scanLibraryEpisodes('lib', false);
    expect(result.map((e) => e.ratingKey)).toEqual(['x']);
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

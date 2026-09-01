import type { Media, PlexStream } from '@server/api/plexapi';
import { describe, expect, it } from 'vitest';
import {
  detectAudioProfile,
  extractMediaCapabilities,
} from './mediaCapabilities';

function makeMedia(overrides?: Partial<Media>): Media {
  return {
    id: 1,
    duration: 5000000,
    bitrate: 15000,
    width: 1920,
    height: 1080,
    aspectRatio: 1.78,
    audioChannels: 6,
    audioCodec: 'aac',
    videoCodec: 'h264',
    videoResolution: '1080',
    container: 'mkv',
    videoFrameRate: '23.976',
    videoProfile: 'main',
    ...overrides,
  };
}

function makeStream(overrides: Partial<PlexStream>): PlexStream {
  return {
    id: 1,
    streamType: 1,
    codec: 'h264',
    ...overrides,
  };
}

describe('extractMediaCapabilities', () => {
  it('extracts basic info from Media without streams', () => {
    const caps = extractMediaCapabilities(makeMedia(), undefined);
    expect(caps.resolution).toBe('1080');
    expect(caps.videoCodec).toBe('h264');
    expect(caps.audioCodec).toBe('aac');
    expect(caps.audioChannels).toBe(6);
    expect(caps.hdr).toBe(false);
    expect(caps.dolbyVision).toBe(false);
    expect(caps.bitDepth).toBe(8);
  });

  it('detects HDR from colorTrc smpte2084', () => {
    const streams = [
      makeStream({
        streamType: 1,
        colorTrc: 'smpte2084',
        bitDepth: 10,
      }),
    ];
    const caps = extractMediaCapabilities(makeMedia(), streams);
    expect(caps.hdr).toBe(true);
    expect(caps.bitDepth).toBe(10);
  });

  it('detects HDR from colorTrc arib (HLG)', () => {
    const streams = [makeStream({ streamType: 1, colorTrc: 'arib-std-b67' })];
    const caps = extractMediaCapabilities(makeMedia(), streams);
    expect(caps.hdr).toBe(true);
  });

  it('detects Dolby Vision', () => {
    const streams = [
      makeStream({
        streamType: 1,
        DOVIPresent: true,
        DOVIProfile: 8,
        bitDepth: 10,
      }),
    ];
    const caps = extractMediaCapabilities(makeMedia(), streams);
    expect(caps.dolbyVision).toBe(true);
    expect(caps.dolbyVisionProfile).toBe(8);
  });

  it('uses audio channels from stream over media level', () => {
    const streams = [
      makeStream({ streamType: 1 }),
      makeStream({ streamType: 2, channels: 8, codec: 'truehd' }),
    ];
    const caps = extractMediaCapabilities(
      makeMedia({ audioChannels: 6 }),
      streams
    );
    expect(caps.audioChannels).toBe(8);
  });

  it('handles 4K resolution', () => {
    const caps = extractMediaCapabilities(
      makeMedia({ videoResolution: '4k', width: 3840, height: 2160 }),
      undefined
    );
    expect(caps.resolution).toBe('4k');
  });
});

describe('detectAudioProfile', () => {
  const audio = (overrides: Partial<PlexStream>): PlexStream =>
    makeStream({ streamType: 2, ...overrides });

  // Captured from live Plex metadata (nostromo, 01/09/2026)
  it('detects TrueHD Atmos from the stream profile (rk 165296)', () => {
    expect(
      detectAudioProfile([
        audio({
          codec: 'truehd',
          channels: 8,
          audioChannelLayout: '7.1',
          profile: 'dolby truehd + dolby atmos',
          displayTitle: 'English (TRUEHD 7.1 + Atmos)',
          extendedDisplayTitle: 'TrueHD Atmos 7.1 (English)',
        }),
        audio({ codec: 'ac3', audioChannelLayout: '5.1(side)' }),
      ])
    ).toBe('truehd_atmos');
  });

  it('detects DD+ Atmos from the stream profile (rk 155609)', () => {
    expect(
      detectAudioProfile([
        audio({
          codec: 'eac3',
          profile: 'dolby digital plus + dolby atmos',
          audioChannelLayout: '5.1(side)',
        }),
      ])
    ).toBe('plus_atmos');
  });

  it('corrects Media-level dca to DTS-HD MA via profile (rk 151762)', () => {
    expect(detectAudioProfile([audio({ codec: 'dca', profile: 'ma' })])).toBe(
      'ma'
    );
  });

  it('detects DTS:X from extendedDisplayTitle when profile says ma (rk 104908)', () => {
    expect(
      detectAudioProfile([
        audio({
          codec: 'dca',
          profile: 'ma',
          displayTitle: 'English (DTS-HD MA 7.1)',
          extendedDisplayTitle: 'DTS-X 7.1 (English)',
        }),
      ])
    ).toBe('dtsx');
  });

  it('does not misread DTS.x264 release names as DTS:X', () => {
    expect(
      detectAudioProfile([
        audio({
          codec: 'ac3',
          extendedDisplayTitle: 'Antiviral.2012.1080p.BluRay.DTS.x264-CHD',
        }),
      ])
    ).toBe('digital');
    expect(
      detectAudioProfile([
        audio({
          codec: 'dca',
          profile: 'dts',
          extendedDisplayTitle: 'Something.DTS.x264-GRP',
        }),
      ])
    ).toBe('dca');
  });

  it('finds the premium track when it is not first', () => {
    expect(
      detectAudioProfile([
        audio({ codec: 'aac', displayTitle: 'Commentary' }),
        audio({ codec: 'truehd', profile: 'dolby truehd + dolby atmos' }),
      ])
    ).toBe('truehd_atmos');
  });

  it('ranks the best track across streams', () => {
    expect(
      detectAudioProfile([
        audio({ codec: 'ac3' }),
        audio({ codec: 'dca', profile: 'es' }),
        audio({ codec: 'eac3' }),
      ])
    ).toBe('dtses');
  });

  it.each([
    ['es profile', { codec: 'dca', profile: 'es' }, 'dtses'],
    ['hra profile', { codec: 'dca', profile: 'hra' }, 'hra'],
    ['x token in profile', { codec: 'dca', profile: 'ma + x' }, 'dtsx'],
    ['plain dts', { codec: 'dca', profile: 'dts' }, 'dca'],
    ['dca-ma media codec', { codec: 'dca-ma', profile: 'ma' }, 'ma'],
    ['bare truehd', { codec: 'truehd' }, 'truehd'],
    ['bare eac3', { codec: 'eac3' }, 'plus'],
    ['ac3', { codec: 'ac3' }, 'digital'],
    ['aac with lc profile', { codec: 'aac', profile: 'lc' }, 'aac'],
    ['flac', { codec: 'flac' }, 'flac'],
  ])('classifies %s', (_name, stream, expected) => {
    expect(detectAudioProfile([audio(stream)])).toBe(expected);
  });

  it('returns undefined for unknown codecs, video-only, and empty input', () => {
    expect(detectAudioProfile([audio({ codec: 'mp2' })])).toBeUndefined();
    expect(detectAudioProfile([audio({ codec: 'vorbis' })])).toBeUndefined();
    expect(
      detectAudioProfile([makeStream({ streamType: 1, codec: 'hevc' })])
    ).toBeUndefined();
    expect(detectAudioProfile([])).toBeUndefined();
  });
});

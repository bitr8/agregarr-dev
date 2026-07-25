import type { Media, PlexStream } from '@server/api/plexapi';
import { describe, expect, it } from 'vitest';
import { extractMediaCapabilities } from './mediaCapabilities';

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

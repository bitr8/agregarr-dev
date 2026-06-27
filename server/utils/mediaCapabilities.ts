/**
 * Single extraction path for media capabilities (HDR, DV, bitDepth, etc.)
 * from Plex stream data. Used by both OverlayContextBuilder and
 * PlexEpisodeMediaScanner so detection logic is never duplicated.
 */

import type { Media, PlexStream } from '@server/api/plexapi';

export interface MediaCapabilities {
  resolution: string;
  hdr: boolean;
  dolbyVision: boolean;
  dolbyVisionProfile?: number;
  videoCodec: string;
  audioCodec: string;
  audioChannels: number;
  bitDepth: number;
}

export function extractMediaCapabilities(
  media: Media,
  streams?: PlexStream[]
): MediaCapabilities {
  const result: MediaCapabilities = {
    resolution: media.videoResolution || 'sd',
    hdr: false,
    dolbyVision: false,
    videoCodec: media.videoCodec || '',
    audioCodec: media.audioCodec || '',
    audioChannels: media.audioChannels || 2,
    bitDepth: 8,
  };

  if (!streams || streams.length === 0) {
    return result;
  }

  const videoStream = streams.find((s) => s.streamType === 1);
  if (videoStream) {
    result.dolbyVision = videoStream.DOVIPresent || false;

    if (videoStream.DOVIProfile !== undefined) {
      result.dolbyVisionProfile = videoStream.DOVIProfile;
    }

    result.hdr =
      videoStream.colorTrc?.toLowerCase().includes('smpte2084') ||
      videoStream.colorTrc?.toLowerCase().includes('arib') ||
      false;

    if (videoStream.bitDepth) {
      result.bitDepth = parseInt(String(videoStream.bitDepth), 10);
    }
  }

  const primaryAudio = streams.find((s) => s.streamType === 2);
  if (primaryAudio?.channels) {
    result.audioChannels = primaryAudio.channels;
  }

  return result;
}

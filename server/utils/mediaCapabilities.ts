/**
 * Single extraction path for media capabilities (HDR, DV, bitDepth, etc.)
 * from Plex stream data. Used by both OverlayContextBuilder and
 * PlexEpisodeMediaScanner so detection logic is never duplicated.
 */

import type { Media, PlexStream } from '@server/api/plexapi';
import logger from '@server/logger';

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

// Ordered best-first; tokens are audio-codec icon filenames
export const AUDIO_PROFILE_RANK = [
  'truehd_atmos',
  'plus_atmos',
  'dtsx',
  'ma',
  'dtses',
  'hra',
  'truehd',
  'plus',
  'dca',
  'digital',
  'flac',
  'pcm',
  'aac',
  'opus',
  'mp3',
] as const;

// Plex classifies DTS:X as profile "ma"; only the display title reveals it
const DTSX_PATTERN = /\bdts[-_ :]?x\b/i;

const loggedUnknownProfiles = new Set<string>();

function noteUnknownProfile(codec: string, profile: string): void {
  const key = `${codec}:${profile}`;
  if (loggedUnknownProfiles.has(key)) return;
  loggedUnknownProfiles.add(key);
  logger.debug('Unrecognised audio stream profile', {
    label: 'MediaCapabilities',
    codec,
    profile,
  });
}

function classifyAudioStream(stream: PlexStream): string | undefined {
  const codec = stream.codec?.toLowerCase() ?? '';
  const profile = stream.profile?.toLowerCase() ?? '';

  if (codec === 'truehd') {
    return profile.includes('atmos') ? 'truehd_atmos' : 'truehd';
  }
  if (codec === 'eac3') {
    return profile.includes('atmos') ? 'plus_atmos' : 'plus';
  }
  if (codec === 'ac3') {
    return 'digital';
  }
  if (codec === 'dca' || codec === 'dca-ma') {
    if (
      DTSX_PATTERN.test(stream.extendedDisplayTitle ?? '') ||
      /\bx\b/.test(profile)
    ) {
      return 'dtsx';
    }
    if (profile === 'ma') return 'ma';
    if (profile === 'es') return 'dtses';
    if (profile === 'hra' || profile === 'hr') return 'hra';
    if (profile && profile !== 'dts') noteUnknownProfile(codec, profile);
    return 'dca';
  }
  if (['flac', 'pcm', 'aac', 'opus', 'mp3'].includes(codec)) {
    return codec;
  }
  return undefined;
}

export function detectAudioProfile(streams: PlexStream[]): string | undefined {
  let best: string | undefined;
  let bestRank: number = AUDIO_PROFILE_RANK.length;
  for (const stream of streams) {
    if (stream.streamType !== 2) continue;
    const token = classifyAudioStream(stream);
    if (!token) continue;
    const rank = AUDIO_PROFILE_RANK.indexOf(
      token as (typeof AUDIO_PROFILE_RANK)[number]
    );
    if (rank !== -1 && rank < bestRank) {
      bestRank = rank;
      best = token;
    }
  }
  return best;
}

/**
 * Backend-agnostic types for episode media scanning and aggregation.
 * Phase 1 of episode/season overlay support.
 */

export interface EpisodeMediaInfo {
  ratingKey: string;
  showRatingKey: string;
  seasonRatingKey: string;
  seasonNumber: number;
  episodeNumber: number;
  resolution: string; // '4k', '1080', '720', 'sd'
  hdr: boolean;
  dolbyVision: boolean;
  dolbyVisionProfile?: number;
  videoCodec: string;
  audioCodec: string;
  audioChannels: number;
  bitDepth: number;
  mediaHash: string; // hash of Plex Media[] for change detection
}

export interface AggregatedMediaInfo {
  resolution: string;
  hdr: boolean;
  dolbyVision: boolean;
  dolbyVisionProfile?: number;
  videoCodec: string;
  audioCodec: string;
  audioChannels: number;
  bitDepth: number;

  episodeCount: number;
  episode4kCount: number;
  episode4kPercent: number;
  episodeHdrCount: number;
  episodeHdrPercent: number;
  episodeDvCount: number;
  episodeDvPercent: number;
  episodeMediaSource: 'aggregated' | 'show';
}

export interface EpisodeMediaScanner {
  scanLibraryEpisodes(
    libraryId: string,
    needsStreamDetail: boolean
  ): Promise<EpisodeMediaInfo[]>;
}

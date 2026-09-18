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
  // Whether HDR/DV/codec detail was actually extracted from a Part stream for
  // this episode (a lightweight list scan, or a full scan that hit a partial
  // getMetadataBatch failure, sets this false). Tracked per episode so a stale
  // or lightweight-only row can't mask itself as detailed.
  hasStreamDetail: boolean;
  // unix seconds. null/undefined both mean "unknown" in memory; the cache
  // layer normalises to explicit null before persisting (see saveEpisodes).
  addedAt?: number | null;
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

  lastEpisodeAddedAt?: number; // unix seconds, from the latest lightweight scan
}

export interface EpisodeMediaScanner {
  scanLibraryEpisodes(
    libraryId: string,
    needsStreamDetail: boolean
  ): Promise<EpisodeMediaInfo[]>;
}

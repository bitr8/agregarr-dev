import type { OverlayRenderContext } from './OverlayTemplateRenderer';

/**
 * Shared sample overlay context factory. Single source of truth for all preview locations:
 * - server/routes/overlayTemplates.ts (single + combined preview)
 * - src/components/OverlayEditor/types.ts (frontend fallback)
 *
 * When adding new OverlayRenderContext fields, add them here first.
 */

const BASE_CONTEXT: Partial<OverlayRenderContext> = {
  // Ratings
  imdbTop250Rank: 42,
  isImdbTop250: true,
  rtCertifiedFresh: true,
  rtVerifiedHot: true,
  plexUserRating: 8,

  // TMDB Metadata
  director: 'Christopher Nolan',
  network: 'HBO',
  genre: 'Action',
  runtime: 148,
  runtimeHHMM: '2h 28m',
  tmdbStatus: 'RETURNING',
  tvdbStatus: 'RETURNING',

  // Plex Media Info
  resolution: '4K',
  width: 3840,
  height: 2160,
  aspectRatio: 2.39,

  // Video specs
  videoCodec: 'hevc',
  videoProfile: 'main 10',
  videoFrameRate: '23.976',
  bitDepth: 10,
  hdr: true,
  dolbyVision: true,
  dolbyVisionProfile: 8,
  colorTrc: 'smpte2084',

  // Audio specs
  audioCodec: 'truehd',
  audioProfile: 'truehd_atmos',
  audioChannels: 8,
  audioChannelLayout: '7.1',
  audioFormat: 'English (Dolby TrueHD Atmos 7.1)',

  // Audio language
  audioLanguage: 'English',
  audioLanguageCode: 'en',
  audioLanguages: ['English', 'German'],
  audioLanguageCodes: ['en', 'de'],

  // Subtitles
  subtitleLanguages: ['English', 'German', 'French'],
  subtitleLanguageCodes: ['en', 'de', 'fr'],
  hasSubtitles: true,

  // File info
  container: 'mkv',
  bitrate: 25000,
  fileSize: 45000000000,
  filePath: '/media/movies/Sample Movie (2024)/Sample Movie (2024).mkv',

  // Playback stats
  viewCount: 3,
  lastPlayed: new Date('2024-12-01'),
  dateAdded: new Date('2024-11-15'),

  // Status fields
  releaseDate: '2024-12-25',
  isEstimatedReleaseDate: false,
  daysUntilRelease: 14,
  daysAgo: 3,
  nextEpisodeAirDate: '2025-01-15',
  daysUntilNextEpisode: 32,
  nextSeasonAirDate: '2025-03-01',
  daysUntilNextSeason: 23,

  // Episode information
  seasonNumber: 2,
  episodeNumber: 5,
  episodeLabel: 'EPISODE 5',

  // Monitoring status
  isMonitored: true,
  inRadarr: true,
  inSonarr: true,
  hasFile: true,
  downloaded: true,

  // Maintainerr integration
  daysUntilAction: 5,

  // Streaming provider
  streamingProvider: 'Netflix',
  streamingProviderId: 8,

  // Plex labels
  plexLabels: ['4K DV', 'HDR'],

  // Content ratings
  'contentRating:US': 'TV-MA',
  'contentRating:GB': '15',
  'contentRating:AU': 'MA15+',
};

const EPISODE_AGGREGATION_FIELDS: Partial<OverlayRenderContext> = {
  showResolution: '1080',
  showHdr: false,
  showDolbyVision: false,
  showDolbyVisionProfile: undefined,
  showAudioCodec: 'aac',
  showAudioChannels: 6,
  showVideoCodec: 'h264',
  showBitDepth: 8,
  episodeCount: 24,
  episode4kCount: 18,
  episode4kPercent: 75,
  episodeHdrCount: 16,
  episodeHdrPercent: 67,
  episodeDvCount: 12,
  episodeDvPercent: 50,
  episodeMediaSource: 'aggregated' as const,
};

export function createSampleOverlayContext(
  mediaType: 'movie' | 'show',
  tmdbOverrides?: {
    title?: string;
    year?: number;
    imdbRating?: number;
    tmdbRating?: number;
    tmdbVoteCount?: number;
    rtCriticsScore?: number;
    rtAudienceScore?: number;
    studio?: string;
    streamingProvider?: string;
    streamingProviderId?: number;
  }
): OverlayRenderContext {
  const context: OverlayRenderContext = {
    ...BASE_CONTEXT,
    title: tmdbOverrides?.title || 'Sample Movie',
    year: tmdbOverrides?.year || 2024,
    imdbRating: tmdbOverrides?.imdbRating || 8.5,
    tmdbRating: tmdbOverrides?.tmdbRating ?? 8.4,
    tmdbVoteCount: tmdbOverrides?.tmdbVoteCount ?? 1250,
    rtCriticsScore: tmdbOverrides?.rtCriticsScore || 92,
    rtAudienceScore: tmdbOverrides?.rtAudienceScore || 88,
    studio: tmdbOverrides?.studio || 'Warner Bros.',
    mediaType,
    isPlaceholder: false,
  };

  if (tmdbOverrides?.streamingProvider !== undefined) {
    context.streamingProvider = tmdbOverrides.streamingProvider;
  }
  if (tmdbOverrides?.streamingProviderId !== undefined) {
    context.streamingProviderId = tmdbOverrides.streamingProviderId;
  }

  if (mediaType === 'show') {
    Object.assign(context, EPISODE_AGGREGATION_FIELDS);
    context.totalSeasons = 5;
    context.seasonsAvailable = 3;
    context.seasonsLeavingCount = 2;
    // Only movies get a theatrical+90 estimate, so deriveReleaseDateContext
    // leaves this undefined for shows. Previewing it as false would let a
    // condition match here and never match live.
    context.isEstimatedReleaseDate = undefined;
    // Stream-derived; the show path never sets it (episode aggregation only
    // fills audioCodec), so previewing one would promise a badge live shows
    // never get.
    context.audioProfile = undefined;
  }

  return context;
}

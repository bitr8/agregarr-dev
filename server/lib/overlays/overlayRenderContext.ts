/**
 * Metadata context for dynamic field replacement
 */
export interface OverlayRenderContext {
  // Ratings (from IMDb API / TMDB / RT API / Plex)
  imdbRating?: number;
  tmdbRating?: number;
  tmdbVoteCount?: number;
  imdbTop250Rank?: number; // IMDb Top 250 ranking (1-250 for movies, 1-250 for TV)
  isImdbTop250?: boolean; // True if item is in IMDb Top 250 list
  rtCriticsScore?: number;
  rtAudienceScore?: number;
  rtCertifiedFresh?: boolean; // True if Rotten Tomatoes Certified Fresh
  rtVerifiedHot?: boolean; // True if Rotten Tomatoes Verified Hot (audience badge)
  plexUserRating?: number; // Plex user rating (0-10 scale where 10 = 5 stars)
  // metacriticScore?: number; // TODO: Implement Metacritic integration

  // TMDB Metadata
  title?: string;
  year?: number;
  director?: string;
  studio?: string;
  network?: string; // For TV shows
  genre?: string;
  runtime?: number;
  runtimeHHMM?: string; // Runtime formatted as "2h 16m"
  tmdbStatus?: string; // TV show status: 'Returning Series', 'Planned', 'Pilot', 'In Production', 'Ended', 'Cancelled'
  tvdbStatus?: string; // TV show status sourced from TVDB: 'RETURNING', 'AIRING', 'ENDED', 'PLANNED'

  // Country/Origin (ISO 3166-1 alpha-2 codes like "US", "GB", "DE")
  originCountry?: string; // Primary country of origin
  originCountries?: string[]; // All countries of origin
  productionCountry?: string; // Primary production country
  productionCountries?: string[]; // All production countries

  // Plex Media Info (from actual file analysis)
  resolution?: string; // '4K', '1080p', '720p'
  width?: number; // Video width in pixels
  height?: number; // Video height in pixels
  aspectRatio?: number; // Aspect ratio (e.g., 2.35)

  versionCount?: number;
  hasMultipleVersions?: boolean;

  // Video specs
  videoCodec?: string; // 'hevc', 'h264', 'av1'
  videoProfile?: string; // 'main', 'high'
  videoFrameRate?: string; // '23.976', '24', '30'
  bitDepth?: number; // 8, 10, 12
  hdr?: boolean; // HDR10/HDR10+
  dolbyVision?: boolean; // Dolby Vision
  dolbyVisionProfile?: number; // Dolby Vision Profile (5, 7, 8, etc.)
  hdr10Plus?: boolean; // HDR10+ dynamic metadata (Plex HDR10PlusPresent)
  colorTrc?: string; // Color transfer characteristic (e.g., 'smpte2084' for HDR10, 'arib' for HLG)

  // Audio specs
  audioCodec?: string; // 'truehd', 'dts', 'aac'
  audioProfile?: string; // Best-track token: 'truehd_atmos', 'plus_atmos', 'dtsx', 'ma', ...
  audioChannels?: number; // 2, 6, 8
  audioChannelLayout?: string; // '5.1', '7.1', 'stereo' (never 'atmos')
  audioFormat?: string; // Full display title (e.g., 'English (Dolby TrueHD Atmos 7.1)')

  // Audio language info
  audioLanguage?: string; // Primary audio track language name (e.g., 'English', 'German')
  audioLanguageCode?: string; // Primary audio track language code (e.g., 'en', 'de')
  audioLanguages?: string[]; // Array of all audio track languages
  audioLanguageCodes?: string[]; // Array of all audio track language codes

  // Subtitle info
  subtitleLanguages?: string[]; // Array of all subtitle languages
  subtitleLanguageCodes?: string[]; // Array of all subtitle language codes
  hasSubtitles?: boolean; // Whether any subtitle tracks are present

  // File info
  container?: string; // 'mkv', 'mp4'
  bitrate?: number; // In kbps
  fileSize?: number; // In bytes
  filePath?: string; // Full file path

  // Playback stats
  viewCount?: number; // Number of times played
  lastPlayed?: Date; // Last playback date
  dateAdded?: Date; // Date added to Plex
  lastEpisodeAddedDate?: Date; // Newest episode addedAt, needs episode scanning
  daysSinceLastEpisodeAdded?: number;

  // Status fields (for Coming Soon / New Release)
  // PRIMARY RELEASE DATE - Smart calculated field
  // MOVIES: Earliest of Digital/Physical > Theatrical (+90 days estimate)
  // TV SHOWS: Series premiere date (NOT next episode!)
  releaseDate?: string;
  isEstimatedReleaseDate?: boolean; // releaseDate is the theatrical+90 estimate, not a published date
  daysUntilRelease?: number; // Days until releaseDate
  daysAgo?: number; // Days since releaseDate
  // MOVIES: published per-type dates (region-preferred); negative daysSince = still in the future
  theatricalReleaseDate?: string;
  digitalReleaseDate?: string;
  physicalReleaseDate?: string;
  daysSinceTheatricalRelease?: number;
  daysSinceDigitalRelease?: number;
  daysSincePhysicalRelease?: number;
  daysSinceHomeRelease?: number; // earliest of digital / physical
  releaseDateSource?: string; // 'digital' | 'physical' | 'estimate' (theatrical+90) | 'tmdb'

  // TV SHOWS - Episode/Season countdowns (separate from releaseDate)
  nextEpisodeAirDate?: string; // Raw date for ANY next episode (including mid-season)
  daysUntilNextEpisode?: number; // Calculated days until ANY next episode
  nextSeasonAirDate?: string; // Raw date for SEASON PREMIERES only (episode 1)
  daysUntilNextSeason?: number; // Calculated days until next SEASON PREMIERE only
  daysAgoNextSeason?: number; // Days since the latest season premiered
  episodesAiringToday?: number;
  todaySeasonNumber?: number;
  todayEpisodeNumber?: number;
  lastAiredEpisodeDate?: string;
  daysSinceLastAiredEpisode?: number;
  lastAiredSeasonNumber?: number;
  lastAiredEpisodeNumber?: number;
  lastAiredEpisodeCount?: number;
  nextEpisodeCount?: number;
  nextFinaleType?: string;
  nextFinaleDate?: string;
  daysUntilNextFinale?: number;
  nextFinaleSeasonNumber?: number;
  nextFinaleEpisodeNumber?: number;
  lastFinaleType?: string;
  lastFinaleDate?: string;
  daysSinceLastFinale?: number;
  nextEpisodeDownloaded?: boolean;
  nextSeasonDownloaded?: boolean;
  nextUndownloadedEpisodeDate?: string;
  daysUntilNextUndownloadedEpisode?: number;
  nextUndownloadedSeasonNumber?: number;
  nextUndownloadedEpisodeNumber?: number;

  totalSeasons?: number;
  seasonsAvailable?: number;

  // Episode information
  seasonNumber?: number;
  episodeNumber?: number;
  episodeLabel?: string; // "SERIES FINALE", "SEASON FINALE", or "EPISODE X"

  // Monitoring status
  isMonitored?: boolean;
  inRadarr?: boolean;
  inSonarr?: boolean;
  hasFile?: boolean; // Whether *arr reports item has files
  downloaded?: boolean; // Derived from hasFile for monitored items, or !isPlaceholder for others
  missingEpisodeCount?: number; // TV
  radarrTags?: string[]; // Array of Radarr tag names
  sonarrTags?: string[]; // Array of Sonarr tag names

  // Maintainerr integration
  daysUntilAction?: number; // Days until Maintainerr takes action (negative = overdue)
  seasonsLeavingCount?: number;

  // Collection membership (populated at runtime from Plex collection contents)
  collection?: string[]; // Array of collection IDs this item belongs to

  // Plex Labels (item-level tags applied in Plex)
  plexLabels?: string[]; // Array of Plex label tags on this item

  // Plex edition (editionTitle, else {edition-...} filename tag)
  edition?: string;

  // Streaming provider (from TMDB watch/providers, flatrate only)
  streamingProvider?: string; // Top flatrate provider name by display_priority
  streamingProviderId?: number; // Top flatrate provider ID (stable, for icon mapping)

  // Episode aggregation (populated when enableEpisodeScanning is on for show libraries)
  showResolution?: string;
  showHdr?: boolean;
  showDolbyVision?: boolean;
  showDolbyVisionProfile?: number;
  showAudioCodec?: string;
  showAudioChannels?: number;
  showVideoCodec?: string;
  showBitDepth?: number;

  episodeCount?: number;
  episode4kCount?: number;
  episode4kPercent?: number;
  episodeHdCount?: number;
  episodeHdPercent?: number;
  episodeSdCount?: number;
  episodeSdPercent?: number;
  episodeUnknownResolutionCount?: number;
  episodeHdrCount?: number;
  episodeHdrPercent?: number;
  episodeDvCount?: number;
  episodeDvPercent?: number;
  episodeMediaSource?: 'aggregated' | 'show';
  episodeMultiVersionCount?: number;

  // Item metadata
  isPlaceholder: boolean; // true = Coming Soon item, false = real item in Plex
  mediaType: 'movie' | 'show';

  // Future extensibility
  [key: string]: string | number | boolean | Date | string[] | undefined;
}

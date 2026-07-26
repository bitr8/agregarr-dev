/**
 * Coming Soon feature type definitions
 */

/**
 * Options for creating placeholder files
 */
export interface PlaceholderOptions {
  /** TMDB ID for metadata matching */
  tmdbId: number;
  /** TVDB ID for TV shows */
  tvdbId?: number;
  /** Item title */
  title: string;
  /** Release year */
  year?: number;
  /** Media type */
  mediaType: 'movie' | 'tv';
  /** Plex library path where placeholder should be created */
  libraryPath: string;
  /** Path to downloaded trailer file */
  trailerPath: string;
  /** Folder name from Sonarr (for TV shows to match Sonarr's naming convention) */
  sonarrFolderName?: string;
}

/**
 * Result of placeholder creation
 */
export interface PlaceholderResult {
  /** Full path to created placeholder file */
  placeholderPath: string;
  /** Filename created */
  filename: string;
}

/**
 * Options for downloading trailers
 */
export interface TrailerDownloadOptions {
  title: string;
  year?: number;
  outputPath: string;
  maxDuration?: number;
}

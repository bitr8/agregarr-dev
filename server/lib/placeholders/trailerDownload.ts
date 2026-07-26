import type { TmdbVideo } from '@server/api/themoviedb/interfaces';
import logger from '@server/logger';
import { spawn } from 'child_process';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import type { TrailerDownloadOptions } from './types';

// Polyfill Intl.ListFormat if not available (needed for @sindresorhus/is in ts-node/CommonJS context)
// This must be done BEFORE any dynamic imports that might use it
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!(global as any).Intl.ListFormat) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).Intl.ListFormat = class ListFormat {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    constructor() {}
    format(list: string[]): string {
      return list.join(', ');
    }
  };
}

interface YoutubeSearchResult {
  id: { videoId: string };
  snippet: { title: string };
}

// Cache the YouTube search module to avoid ES Module race conditions
let youtubeSearchModule: {
  search: (query: string) => Promise<YoutubeSearchResult[]>;
} | null = null;

async function getYoutubeSearch() {
  if (!youtubeSearchModule) {
    const imported = await import('youtube-search-without-api-key');
    youtubeSearchModule = imported.default || imported;
  }
  return youtubeSearchModule;
}

const DEFAULT_EXCLUDE_WORDS =
  'review, reaction, behind the scenes, breakdown, explained, fan made, concept';

/**
 * Parse comma-separated word list into trimmed lowercase array
 */
function parseWordList(words: string | undefined): string[] {
  if (!words || !words.trim()) return [];
  return words
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Check if a title passes the include/exclude word filters.
 * Include: ALL words must be present. Exclude: ANY word rejects.
 */
export function titlePassesWordFilter(
  title: string,
  includeWords: string[],
  excludeWords: string[]
): boolean {
  const lower = title.toLowerCase();
  if (excludeWords.some((w) => lower.includes(w))) return false;
  if (includeWords.length > 0 && !includeWords.every((w) => lower.includes(w)))
    return false;
  return true;
}

/**
 * Select the best trailer from TMDB videos list.
 * Filters YouTube-only, applies exclude words, scores by type and official status,
 * sorts by published_at newest first.
 */
export function selectTmdbTrailer(
  videos: TmdbVideo[],
  excludeWords: string[]
): TmdbVideo[] {
  return videos
    .filter((v) => v.site === 'YouTube')
    .filter((v) => v.type === 'Trailer' || v.type === 'Teaser')
    .filter((v) => titlePassesWordFilter(v.name, [], excludeWords))
    .sort((a, b) => {
      // Trailer > Teaser
      const typeScore = (v: TmdbVideo) => (v.type === 'Trailer' ? 2 : 1);
      const ts = typeScore(b) - typeScore(a);
      if (ts !== 0) return ts;
      // official first
      if (a.official !== b.official) return a.official ? -1 : 1;
      // newest first
      return (
        new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
      );
    });
}

/**
 * Copy static placeholder video as fallback
 */
async function copyPlaceholderVideo(outputPath: string): Promise<void> {
  logger.debug('Using static placeholder video', {
    label: 'PlaceholderService',
    outputPath,
  });

  try {
    const placeholderPath = path.join(
      process.cwd(),
      'public',
      'assets',
      'placeholder.mp4'
    );
    await fsPromises.copyFile(placeholderPath, outputPath);

    logger.info('Copied static placeholder video', {
      label: 'PlaceholderService',
      outputPath,
    });
  } catch (error) {
    logger.error('Failed to copy placeholder video', {
      label: 'PlaceholderService',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Download YouTube video using yt-dlp with duration filtering
 */
async function downloadWithYtDlp(
  videoUrl: string,
  outputPath: string,
  maxDuration = 210
): Promise<void> {
  return new Promise((resolve, reject) => {
    logger.debug('Downloading with yt-dlp', {
      label: 'PlaceholderService',
      videoUrl,
      outputPath,
      maxDuration,
    });

    const args = [
      '--break-on-reject',
      '--match-filter',
      `duration < ${maxDuration}`,
      '-f',
      'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]',
      '--merge-output-format',
      'mp4',
      '-o',
      outputPath,
    ];

    // Auto-detect cookies file in config directory
    const cookiesPath = path.join(
      process.cwd(),
      'config',
      'youtube-cookies.txt'
    );
    try {
      fs.accessSync(cookiesPath);
      args.push('--cookies', cookiesPath);
      logger.debug('Using YouTube cookies for download', {
        label: 'PlaceholderService',
        cookiesPath,
      });
    } catch {
      logger.debug(
        'No YouTube cookies file found, proceeding without cookies',
        {
          label: 'PlaceholderService',
          expectedPath: cookiesPath,
        }
      );
    }

    args.push(videoUrl);

    const ytdlp = spawn('yt-dlp', args);

    let stdoutOutput = '';
    let stderrOutput = '';

    ytdlp.stdout.on('data', (data) => {
      stdoutOutput += data.toString();
    });

    ytdlp.stderr.on('data', (data) => {
      stderrOutput += data.toString();
    });

    ytdlp.on('close', (code) => {
      if (code === 0) {
        logger.info('Successfully downloaded trailer with yt-dlp', {
          label: 'PlaceholderService',
          outputPath,
        });
        resolve();
      } else {
        const isDurationFilterRejection =
          code === 101 && stdoutOutput.includes('does not pass filter');

        if (isDurationFilterRejection) {
          const titleMatch = stdoutOutput.match(
            /\[download\] (.+?) does not pass filter/
          );
          const videoTitle = titleMatch ? titleMatch[1] : 'Video';

          logger.info('Video rejected by duration filter', {
            label: 'PlaceholderService',
            videoTitle,
            maxDuration: maxDuration,
          });
        } else {
          logger.error('yt-dlp download failed', {
            label: 'PlaceholderService',
            code,
            stdout: stdoutOutput,
            stderr: stderrOutput,
          });
        }

        reject(new Error(`yt-dlp exited with code ${code}: ${stderrOutput}`));
      }
    });

    ytdlp.on('error', (error) => {
      logger.error('yt-dlp spawn error', {
        label: 'PlaceholderService',
        error: error.message,
      });
      reject(error);
    });
  });
}

/**
 * Attempt to download a trailer from TMDB video candidates.
 * Tries up to 3 candidates, returns true if one succeeded.
 */
async function tryTmdbCandidates(
  candidates: TmdbVideo[],
  outputPath: string
): Promise<boolean> {
  const maxAttempts = Math.min(candidates.length, 3);
  for (let i = 0; i < maxAttempts; i++) {
    const video = candidates[i];
    const videoUrl = `https://www.youtube.com/watch?v=${video.key}`;
    try {
      // 600s sanity cap on TMDB path (legitimate long trailers exist)
      await downloadWithYtDlp(videoUrl, outputPath, 600);
      logger.info('Downloaded trailer from TMDB source', {
        label: 'PlaceholderService',
        videoName: video.name,
        type: video.type,
        official: video.official,
      });
      return true;
    } catch (error) {
      logger.debug('TMDB candidate download failed, trying next', {
        label: 'PlaceholderService',
        videoName: video.name,
        attempt: i + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return false;
}

/**
 * Resolve trailer via TMDB /videos (already cached by getMovie/getTvShow)
 */
async function resolveFromTmdb(
  tmdbId: number,
  mediaType: 'movie' | 'tv',
  excludeWords: string[],
  outputPath: string
): Promise<boolean> {
  try {
    const TmdbApi = (await import('@server/api/themoviedb')).default;
    const tmdb = new TmdbApi();

    let videos: TmdbVideo[] = [];
    if (mediaType === 'movie') {
      const movie = await tmdb.getMovie({ movieId: tmdbId });
      videos = movie.videos?.results ?? [];
    } else {
      const show = await tmdb.getTvShow({ tvId: tmdbId });
      videos = show.videos?.results ?? [];
    }

    if (videos.length === 0) {
      logger.debug('No TMDB videos found', {
        label: 'PlaceholderService',
        tmdbId,
        mediaType,
      });
      return false;
    }

    const candidates = selectTmdbTrailer(videos, excludeWords);
    if (candidates.length === 0) {
      logger.debug('No suitable TMDB trailer candidates after filtering', {
        label: 'PlaceholderService',
        tmdbId,
        totalVideos: videos.length,
      });
      return false;
    }

    logger.info('Attempting TMDB trailer download', {
      label: 'PlaceholderService',
      tmdbId,
      mediaType,
      candidateCount: candidates.length,
      topCandidate: candidates[0].name,
    });

    return await tryTmdbCandidates(candidates, outputPath);
  } catch (error) {
    logger.warn('TMDB trailer resolution failed', {
      label: 'PlaceholderService',
      tmdbId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Search YouTube and download first passing candidate
 */
async function searchAndDownloadFromYoutube(
  options: TrailerDownloadOptions,
  includeWords: string[],
  excludeWords: string[]
): Promise<void> {
  const { title, year, outputPath } = options;

  logger.info('Searching for YouTube trailer (fallback)', {
    label: 'PlaceholderService',
    title,
    year,
  });

  try {
    const searchQuery = `${title}${year ? ` ${year}` : ''} official trailer`;
    const youtubeSearch = await getYoutubeSearch();
    const searchResults = await youtubeSearch.search(searchQuery);

    if (!searchResults || searchResults.length === 0) {
      logger.warn('No YouTube trailers found, using fallback', {
        label: 'PlaceholderService',
        title,
      });
      await copyPlaceholderVideo(outputPath);
      return;
    }

    // Iterate results (up to 10), first passing word filter wins
    const maxCandidates = Math.min(searchResults.length, 10);
    for (let i = 0; i < maxCandidates; i++) {
      const result = searchResults[i];
      if (
        !titlePassesWordFilter(result.snippet.title, includeWords, excludeWords)
      ) {
        logger.debug('YouTube result rejected by word filter', {
          label: 'PlaceholderService',
          videoTitle: result.snippet.title,
        });
        continue;
      }

      const videoUrl = `https://www.youtube.com/watch?v=${result.id.videoId}`;
      logger.info('Downloading YouTube trailer', {
        label: 'PlaceholderService',
        title,
        videoTitle: result.snippet.title,
        videoId: result.id.videoId,
      });

      const maxDuration = options.maxDuration || 210;
      await downloadWithYtDlp(videoUrl, outputPath, maxDuration);
      return;
    }

    logger.warn('All YouTube results rejected by word filter', {
      label: 'PlaceholderService',
      title,
      checkedCount: maxCandidates,
    });
    await copyPlaceholderVideo(outputPath);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isDurationFilterRejection =
      errorMessage.includes('code 101') &&
      errorMessage.includes('does not pass filter');

    if (isDurationFilterRejection) {
      logger.info('Trailer video too long, using placeholder instead', {
        label: 'PlaceholderService',
        title,
      });
    } else {
      logger.error('Failed to download YouTube trailer, using fallback', {
        label: 'PlaceholderService',
        error: errorMessage,
        title,
      });
    }
    await copyPlaceholderVideo(outputPath);
  }
}

/**
 * Download trailer for a movie or TV show.
 * Resolution order: TMDB /videos → YouTube search (filtered) → static placeholder.
 */
export async function downloadTrailer(
  title: string,
  year?: number,
  mediaType: 'movie' | 'tv' = 'movie',
  tmdbId?: number
): Promise<string> {
  const tempDir = path.join(process.cwd(), 'config', 'temp', 'trailers');

  try {
    await fsPromises.mkdir(tempDir, { recursive: true });

    const sanitizedTitle = title
      .replace(/[<>:"/\\|?*]/g, '')
      .replace(/\s+/g, '_');
    const yearStr = year ? `_${year}` : '';
    const filename = `${sanitizedTitle}${yearStr}_trailer.mp4`;
    const outputPath = path.join(tempDir, filename);

    // Check if trailer already exists in cache
    try {
      await fsPromises.access(outputPath);
      logger.debug('Trailer already exists in cache', {
        label: 'PlaceholderService',
        title,
        outputPath,
      });
      return outputPath;
    } catch {
      // Trailer doesn't exist, proceed to download
    }

    const { getSettings } = await import('@server/lib/settings');
    const settings = getSettings();

    if (settings.main.skipYoutubeTrailerDownloads) {
      logger.info(
        'YouTube trailer downloads disabled - using hardcoded placeholder video',
        {
          label: 'PlaceholderService',
          title,
          year,
          mediaType,
        }
      );
      await copyPlaceholderVideo(outputPath);
      return outputPath;
    }

    const preferTmdb = settings.main.preferTmdbTrailers !== false;
    const excludeWords = parseWordList(
      settings.main.trailerExcludeWords?.trim() || DEFAULT_EXCLUDE_WORDS
    );
    const includeWords = parseWordList(settings.main.trailerIncludeWords);

    logger.info('Downloading trailer', {
      label: 'PlaceholderService',
      title,
      year,
      mediaType,
      tmdbId,
      preferTmdb,
    });

    // TMDB path: resolve from authoritative video list
    if (preferTmdb && tmdbId) {
      const tmdbSuccess = await resolveFromTmdb(
        tmdbId,
        mediaType,
        excludeWords,
        outputPath
      );
      if (tmdbSuccess) return outputPath;
      logger.debug('TMDB path exhausted, falling through to YouTube search', {
        label: 'PlaceholderService',
        title,
        tmdbId,
      });
    }

    // YouTube search fallback (with word list filtering)
    await searchAndDownloadFromYoutube(
      { title, year, outputPath, maxDuration: 210 },
      includeWords,
      excludeWords
    );

    return outputPath;
  } catch (error) {
    logger.error('Failed to download trailer', {
      label: 'PlaceholderService',
      error: error instanceof Error ? error.message : String(error),
      title,
      year,
    });
    throw error;
  }
}

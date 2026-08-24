import type { PlexLibraryItem } from '@server/api/plexapi';

export interface ImdbPrefetchCandidate {
  imdbId: string;
  releaseYear: number | undefined;
}

export interface TmdbImdbLookupCandidate {
  tmdbId: number;
  itemType: 'movie' | 'show';
  year?: number;
}

export interface ImdbPrefetchCandidates {
  imdbData: Map<string, ImdbPrefetchCandidate>;
  needTmdbLookup: TmdbImdbLookupCandidate[];
  processableItems: number;
  plexImdbCount: number;
}

/**
 * Collect direct IMDb GUIDs from movies, shows, and episodes. Seasons have no
 * canonical IMDb title and are excluded from direct lookup; their displayed
 * rating is derived separately from the season's rated episodes. An episode's
 * TMDB GUID belongs to the episode namespace and must never be queried as a
 * TV-show ID.
 */
export function collectImdbPrefetchCandidates(
  items: PlexLibraryItem[]
): ImdbPrefetchCandidates {
  const processableItems = items.filter((item) => item.type !== 'season');
  const imdbData = new Map<string, ImdbPrefetchCandidate>();
  const needTmdbLookup: TmdbImdbLookupCandidate[] = [];
  const seenTmdbLookups = new Set<string>();
  let plexImdbCount = 0;

  for (const item of processableItems) {
    if (!item.Guid || !Array.isArray(item.Guid)) continue;

    const imdbGuid = item.Guid.find((guid) => guid.id?.startsWith('imdb://'));
    if (imdbGuid) {
      const imdbId = imdbGuid.id.replace('imdb://', '');
      if (imdbId && !imdbData.has(imdbId)) {
        imdbData.set(imdbId, { imdbId, releaseYear: item.year });
        plexImdbCount++;
      }
      continue;
    }

    // TMDB episode IDs cannot be resolved through the show endpoint. Missing
    // episode IMDb IDs therefore have no episode-specific IMDb rating.
    if (item.type === 'episode') continue;

    const tmdbGuid = item.Guid.find((guid) => guid.id?.startsWith('tmdb://'));
    const match = tmdbGuid?.id.match(/tmdb:\/\/(\d+)/);
    if (!match) continue;

    const tmdbId = parseInt(match[1], 10);
    const itemType = item.type === 'movie' ? 'movie' : 'show';
    const lookupKey = `${itemType}:${tmdbId}`;
    if (seenTmdbLookups.has(lookupKey)) continue;

    seenTmdbLookups.add(lookupKey);
    needTmdbLookup.push({ tmdbId, itemType, year: item.year });
  }

  return {
    imdbData,
    needTmdbLookup,
    processableItems: processableItems.length,
    plexImdbCount,
  };
}

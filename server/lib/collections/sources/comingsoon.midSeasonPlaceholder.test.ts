import type PlexAPI from '@server/api/plexapi';
import type { ComingSoonSourceData } from '@server/lib/collections/core/types';
import type { CollectionConfig } from '@server/lib/settings';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/datasource', () => ({
  getRepository: vi.fn(() => ({ find: vi.fn(async () => []) })),
}));
vi.mock('@server/entity/ComingSoonItem', () => ({ ComingSoonItem: class {} }));
vi.mock('@server/entity/CollectionMetadata', () => ({
  CollectionMetadata: class {},
}));
vi.mock('@server/entity/CollectionMissingItems', () => ({
  CollectionMissingItems: class {},
}));
vi.mock('@server/entity/PosterTemplate', () => ({ PosterTemplate: class {} }));
vi.mock('@server/entity/User', () => ({ User: class {} }));
vi.mock('@server/api/imdbRatings', () => ({ default: class {} }));
vi.mock('@server/lib/cache', () => ({ default: { getCache: vi.fn() } }));
vi.mock('@server/lib/posterStorage', () => ({ generatePoster: vi.fn() }));
vi.mock('@server/lib/collections/services/ServiceUserManager', () => ({
  serviceUserManager: {},
}));
vi.mock('@server/lib/collections/utils/TemplateEngine', () => ({
  templateEngine: { processTemplate: (t: string) => t },
}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({ plex: { collectionConfigs: [], libraries: [] } }),
}));
vi.mock('@server/lib/collections/core/CollectionUtilities', async () => {
  const actual = await vi.importActual<object>(
    '@server/lib/collections/core/CollectionUtilities'
  );
  return { ...actual, findPlexItemsByTmdbIds: vi.fn(async () => new Map()) };
});
vi.mock('./comingsoon/comingSoonFetch', () => ({
  enrichWithTMDBReleaseDates: vi.fn(),
  fetchMonitoredMovies: vi.fn(),
  fetchMonitoredShows: vi.fn(),
  fetchTmdbComingSoonMovies: vi.fn(),
  fetchTmdbComingSoonShows: vi.fn(),
  fetchTraktAnticipatedMovies: vi.fn(),
  fetchTraktAnticipatedShows: vi.fn(),
  markMonitoredStatus: vi.fn(),
}));

import { ComingSoonCollectionSync } from './comingsoon';

const show = (tmdbId: number, episodeNumber: number): ComingSoonSourceData => ({
  tmdbId,
  tvdbId: tmdbId + 1000,
  title: `Show ${tmdbId}`,
  mediaType: 'tv',
  source: 'sonarr',
  monitored: true,
  airDate: '2030-01-01T00:00:00Z',
  seasonNumber: 2,
  episodeNumber,
});

const run = async (includeMidSeason: boolean) => {
  const sync = new ComingSoonCollectionSync();
  const config = {
    id: '1',
    name: 'Soon',
    type: 'comingsoon',
    subtype: 'monitored',
    libraryId: '5',
    comingSoonIncludeMidSeason: includeMidSeason,
  } as unknown as CollectionConfig;
  return sync.mapSourceDataToItems(
    [show(1, 1), show(2, 5)],
    config,
    {} as PlexAPI
  );
};

describe('mid-season shows and placeholders', () => {
  it('does not queue a placeholder for a mid-season show missing from Plex', async () => {
    const { missingItems } = await run(true);
    expect(missingItems.map((m) => m.tmdbId)).toEqual([1]);
  });

  it('keeps queuing every show when the option is off', async () => {
    const { missingItems } = await run(false);
    expect(missingItems.map((m) => m.tmdbId)).toEqual([1, 2]);
  });
});

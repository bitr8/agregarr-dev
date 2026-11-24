import type PlexAPI from '@server/api/plexapi';
import { prefetchAllLibraryItems } from '@server/lib/collections/core/CollectionUtilities';
import { autoRequestService } from '@server/lib/collections/services/AutoRequestService';
import type { CollectionConfig } from '@server/lib/settings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MyAnimeListCollectionSync } from './myanimelist';

const { excludedShows, getRankedAnime } = vi.hoisted(() => ({
  excludedShows: [] as { type: 'tvdb'; id: number }[],
  getRankedAnime: vi.fn(),
}));
vi.mock('@server/api/myanimelist', () => ({ getRankedAnime }));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    globalExclusions: { movies: [], shows: excludedShows },
    plex: { collectionConfigs: [], libraries: [{ key: '1', type: 'show' }] },
  }),
}));
vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/lib/placeholders/services/PlaceholderCleanup', () => ({
  handlePlaceholderCleanup: vi.fn(),
}));
vi.mock('@server/lib/collections/services/AutoRequestService', () => ({
  autoRequestService: { processAutoRequests: vi.fn() },
}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('MAL collection sync', () => {
  const config = {
    id: 'c',
    name: 'MAL',
    type: 'myanimelist',
    libraryId: '1',
    collectionRatingKey: 'collection',
    autoPoster: false,
    searchMissingTV: true,
  } as CollectionConfig;
  const entry = {
    malId: 64340,
    rank: 1,
    title: 'Overgeared',
    raw: { media_type: 'tv' },
  };
  const series = {
    'tmdb_show:324502:s1': { '1-12': '1-12' },
    'tvdb_show:478752:s1': { '1-12': '1-12' },
  };
  const data = {
    $meta: { schema_version: '3.0.3' },
    'anilist:212888': series,
    'mal:64340': series,
    'mal:2': series,
  };
  class Sync extends MyAnimeListCollectionSync {
    protected async updateCollectionMetadata() {
      return { ratingKeyIsStale: false };
    }
    protected persistCollectionRatingKey() {}
  }
  const plex = {
    getLibraries: async () => [{ key: '1', type: 'show' }],
    getLibraryContents: vi.fn(),
    getCollectionMetadata: async () => ({
      librarySectionID: '1',
      ratingKey: 'collection',
      title: 'MAL',
    }),
    updateCollectionContentSort: vi.fn(),
    updateCollectionContents: vi.fn(async () => ({ removedKeys: [] })),
    getItemsWithLabel: async () => [],
    recordPhaseTime: vi.fn(),
  };
  const client = plex as unknown as PlexAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    excludedShows.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(data)))
    );
    getRankedAnime.mockResolvedValue({
      data: [64340, 2].map((id) => ({
        node: { id, title: 'Overgeared', media_type: 'tv' },
        ranking: { rank: 1 },
      })),
    });
    plex.getLibraryContents.mockResolvedValue({
      items: [
        {
          ratingKey: 'owned',
          title: 'Overgeared',
          guid: 'com.plexapp.agents.myanimelist://64340',
        },
      ],
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['cached preview', 'fresh ranking'])(
    'loads mappings on a cold %s',
    async (mode) => {
      vi.resetModules();
      const { MyAnimeListCollectionSync: ColdSync } = await import(
        './myanimelist'
      );
      const sync = new ColdSync();
      const cache = await prefetchAllLibraryItems(client);
      const rows =
        mode === 'cached preview'
          ? [entry]
          : await sync.fetchSourceData(config, undefined, cache);
      if (mode === 'fresh ranking') expect(fetch).toHaveBeenCalledTimes(1);
      const mapped = await sync.mapSourceDataToItems(
        rows,
        config,
        client,
        cache
      );
      expect(mapped.items[0]?.ratingKey).toBe('owned');
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );

  it('writes the owned primary-GUID series once and never requests it', async () => {
    const sync = new Sync();
    vi.spyOn(sync, 'generateCollectionNameWithCustom').mockResolvedValue('MAL');
    await sync['processConfiguration'](
      config,
      client,
      [],
      undefined,
      await prefetchAllLibraryItems(client)
    );
    expect(plex.updateCollectionContents).toHaveBeenCalledWith(
      'collection',
      [{ ratingKey: 'owned', title: 'Overgeared' }],
      'MAL'
    );
    expect(autoRequestService.processAutoRequests).not.toHaveBeenCalled();
  });

  it('honours TVDB exclusions at both writers and requests an allowed missing series only once', async () => {
    const sync = new Sync();
    excludedShows.push({ type: 'tvdb', id: 478752 });
    for (const cache of [await prefetchAllLibraryItems(client), { '1': [] }]) {
      await sync['processConfiguration'](config, client, [], undefined, cache);
    }
    expect(plex.updateCollectionContents).not.toHaveBeenCalled();
    expect(autoRequestService.processAutoRequests).not.toHaveBeenCalled();
    excludedShows.length = 0;
    await sync['processConfiguration'](config, client, [], undefined, {
      '1': [],
    });
    expect(autoRequestService.processAutoRequests).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          tmdbId: 324502,
          tvdbId: 478752,
          originalPosition: 1,
        }),
      ],
      config,
      'myanimelist'
    );
  });
});

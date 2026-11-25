import type PlexAPI from '@server/api/plexapi';
import { CollectionSyncErrorType } from '@server/lib/collections/core/types';
import type { CollectionConfig } from '@server/lib/settings';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/api/animeIds', () => ({
  ensureAnimeIdsLoaded: vi.fn().mockResolvedValue(undefined),
  lookupByAniList: vi.fn(),
  lookupByMal: vi.fn(),
}));
vi.mock('@server/api/anilist', () => ({
  getFeedsFirstPage: vi.fn(),
  getPopularAnime: vi.fn(),
  getTopRatedAnime: vi.fn(),
  getTrendingAnime: vi.fn(),
  getUserCustomLists: vi.fn(),
  searchAnime: vi.fn(),
}));
vi.mock('@server/api/imdbRatings', () => ({ default: class {} }));
vi.mock('@server/lib/cache', () => ({ default: { getCache: vi.fn() } }));
vi.mock('@server/lib/posterStorage', () => ({ generatePoster: vi.fn() }));
vi.mock('@server/lib/collections/services/ServiceUserManager', () => ({
  serviceUserManager: {},
}));
vi.mock('@server/lib/collections/utils/TemplateEngine', () => ({
  templateEngine: {},
}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    plex: { collectionConfigs: [], libraries: [{ key: '1', type: 'movie' }] },
    myanimelist: { apiKey: 'test-key' },
    save: vi.fn(),
  }),
}));

import { getUserCustomLists, searchAnime } from '@server/api/anilist';
import { AnilistCollectionSync } from './anilist';
import { MyAnimeListCollectionSync } from './myanimelist';

describe.each([
  ['anilist', AnilistCollectionSync],
  ['myanimelist', MyAnimeListCollectionSync],
] as const)('%s source fetch failure', (type, SyncClass) => {
  it('rejects a cache containing only a foreign library before fetching a page', async () => {
    const sync = new SyncClass();
    await expect(
      sync.fetchSourceData(
        { type, libraryId: '1' } as CollectionConfig,
        undefined,
        { other: [] }
      )
    ).rejects.toThrow('Plex library 1 is missing from the library cache');
  });

  it('reaches the sync result with the real cause', async () => {
    const sync = new SyncClass();
    vi.spyOn(sync, 'fetchSourceData').mockRejectedValue(
      sync['createSyncError'](
        CollectionSyncErrorType.API_ERROR,
        'upstream list unavailable'
      )
    );
    const cfg = {
      id: 'c1',
      name: 'Test List',
      type,
      subtype: 'custom_list',
      libraryId: '1',
      isActive: true,
    } as CollectionConfig;

    const result = await sync.processCollections(
      [cfg],
      { recordCollectionProcessingTime: vi.fn() } as unknown as PlexAPI,
      [],
      undefined,
      { '1': [] }
    );

    expect(result.error).toContain('upstream list unavailable');
    expect(result.created + result.updated).toBe(0);
  });
});

describe('anilist custom URL', () => {
  const run = (url: string) => {
    const sync = new AnilistCollectionSync();
    const cfg = {
      id: 'c1',
      name: 'Test List',
      type: 'anilist',
      subtype: 'custom',
      anilistCustomListUrl: url,
      libraryId: '1',
      isActive: true,
    } as CollectionConfig;
    return sync.processCollections(
      [cfg],
      { recordCollectionProcessingTime: vi.fn() } as unknown as PlexAPI,
      [],
      undefined,
      { '1': [] }
    );
  };

  it('reports a failed user-list fetch', async () => {
    vi.mocked(getUserCustomLists).mockRejectedValue(new Error('anilist down'));
    const result = await run('https://example.test/user/testuser/animelist');
    expect(result.error).toContain('anilist down');
  });

  it('reports a failed search fetch', async () => {
    vi.mocked(searchAnime).mockRejectedValue(new Error('search down'));
    const result = await run('https://example.test/search/anime?genres=Comedy');
    expect(result.error).toContain('search down');
  });

  it('treats a malformed URL as an empty list, not a failure', async () => {
    const result = await run('not a url');
    expect(result.error).toBeUndefined();
    expect(result.created + result.updated).toBe(0);
  });
});

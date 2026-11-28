import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureAnimeIdsLoaded,
  loadAnimeIds,
  lookupByAniList,
  lookupByMal,
} from './animeIds';

describe('AniBridge mapping cache', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shares refreshes, retains the last valid index on failure, and retries', async () => {
    const valid = {
      $meta: { schema_version: '3.0.3' },
      'anilist:1': { 'tmdb_movie:2': { '1': '1' } },
      'mal:7': { 'tmdb_movie:2': { '1': '1' } },
    };
    const response = (data: unknown) => new Response(JSON.stringify(data));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(valid))
      .mockResolvedValueOnce(response({ '1': { tmdb_movie_id: 3 } }))
      .mockResolvedValueOnce(response({ $meta: valid.$meta }))
      .mockResolvedValueOnce(response({ ...valid, 'mal:7': {} }))
      .mockResolvedValueOnce(response(valid));
    vi.stubGlobal('fetch', fetch);
    await Promise.all([ensureAnimeIdsLoaded(), ensureAnimeIdsLoaded()]);
    await ensureAnimeIdsLoaded();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(
      'https://github.com/anibridge/anibridge-mappings/releases/download/v3/mappings.min.json'
    );
    await expect(ensureAnimeIdsLoaded(-1)).rejects.toThrow('schema');
    await expect(loadAnimeIds()).rejects.toThrow('no usable');
    await expect(ensureAnimeIdsLoaded(-1)).rejects.toThrow('no usable MAL');
    expect(lookupByMal(7, 'movie')).toEqual({ tmdb: '2' });
    expect(lookupByAniList(1, 'movie')).toEqual({ tmdb: '2' });
    await ensureAnimeIdsLoaded(-1);
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});

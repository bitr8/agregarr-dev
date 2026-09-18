import type PlexAPI from '@server/api/plexapi';
import type { PlexLibraryItem } from '@server/api/plexapi';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Lazily read inside functions (not at import time), so a plain factory is
// enough - no vi.hoisted/TDZ concern here. `plex` is needed by
// recoverOriginalPlexPoster, which reads settings.plex.{ip,port,useSsl}.
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    main: { tmdbLanguage: 'en' },
    plex: { ip: '127.0.0.1', port: 32400, useSsl: false },
  }),
  getTmdbLanguage: async () => 'en',
}));

import {
  plexBasePosterManager,
  resolveBasePosterSource,
} from './PlexBasePosterManager';

function item(overrides: Partial<PlexLibraryItem> = {}): PlexLibraryItem {
  return {
    ratingKey: '123',
    title: 'Test Show',
    guid: 'plex://show/123',
    addedAt: 0,
    updatedAt: 0,
    type: 'show',
    Media: [],
    ...overrides,
  } as unknown as PlexLibraryItem;
}

function settingsWith(
  defaultPosterSource: 'tmdb' | 'plex' | 'local'
): Parameters<typeof resolveBasePosterSource>[1] {
  return {
    overlays: { defaultPosterSource },
  } as unknown as Parameters<typeof resolveBasePosterSource>[1];
}

function plexApiStub(currentPosterUrl: string | null): PlexAPI {
  return {
    getCurrentPosterUrl: vi.fn().mockResolvedValue(currentPosterUrl),
    plexToken: 'test-token',
  } as unknown as PlexAPI;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveBasePosterSource (fork#110)', () => {
  it('always uses Plex for a season, regardless of the setting', () => {
    const season = item({ type: 'season', Guid: [{ id: 'tmdb://123' }] });
    expect(resolveBasePosterSource(season, settingsWith('tmdb'))).toBe('plex');
  });

  it('always uses Plex for an episode, regardless of the setting', () => {
    const episode = item({ type: 'episode', Guid: [{ id: 'tmdb://123' }] });
    expect(resolveBasePosterSource(episode, settingsWith('tmdb'))).toBe('plex');
  });

  it('falls back to Plex when the setting is tmdb but the item has no tmdb:// guid', () => {
    const noGuid = item({
      Guid: [{ id: 'imdb://tt12736950' }, { id: 'tvdb://376900' }],
    });
    expect(resolveBasePosterSource(noGuid, settingsWith('tmdb'))).toBe('plex');
  });

  it('uses tmdb when the setting is tmdb and the item has a tmdb:// guid', () => {
    const withGuid = item({ Guid: [{ id: 'tmdb://123' }] });
    expect(resolveBasePosterSource(withGuid, settingsWith('tmdb'))).toBe(
      'tmdb'
    );
  });

  it('honours a plex setting even with no guid at all', () => {
    const noGuid = item({ Guid: undefined });
    expect(resolveBasePosterSource(noGuid, settingsWith('plex'))).toBe('plex');
  });

  it('honours a local setting even with no guid at all', () => {
    const noGuid = item({ Guid: undefined });
    expect(resolveBasePosterSource(noGuid, settingsWith('local'))).toBe(
      'local'
    );
  });

  it('treats an item with no Guid array as having no tmdb id under the tmdb setting', () => {
    const noGuidArray = item({ Guid: undefined });
    expect(resolveBasePosterSource(noGuidArray, settingsWith('tmdb'))).toBe(
      'plex'
    );
  });
});

describe('getBasePosterForOverlay driven by resolveBasePosterSource (fork#110)', () => {
  it('takes the Plex branch when the resolver falls back (no tmdb:// guid)', async () => {
    const testItem = item({
      Guid: [{ id: 'imdb://tt12736950' }, { id: 'tvdb://376900' }],
    });
    const posterSource = resolveBasePosterSource(
      testItem,
      settingsWith('tmdb')
    );
    expect(posterSource).toBe('plex');

    const plexUrl = 'https://plex.local/library/metadata/123/thumb/1';
    const plexApi = plexApiStub(plexUrl);

    vi.spyOn(plexBasePosterManager, 'getStoredBasePoster').mockResolvedValue(
      Buffer.from('cached-poster')
    );

    const result = await plexBasePosterManager.getBasePosterForOverlay(
      plexApi,
      testItem,
      'lib-1',
      'Shows',
      'show',
      posterSource,
      {}
    );

    expect(result.sourceUrl).toBe(plexUrl);
    expect(result.posterBuffer.toString()).toBe('cached-poster');
  });

  it('takes the TMDB branch when the resolver keeps tmdb (item has a tmdb:// guid)', async () => {
    const testItem = item({ Guid: [{ id: 'tmdb://123' }] });
    const posterSource = resolveBasePosterSource(
      testItem,
      settingsWith('tmdb')
    );
    expect(posterSource).toBe('tmdb');

    const plexApi = plexApiStub('https://plex.local/should-not-be-used');
    const getCurrentPosterUrl = plexApi.getCurrentPosterUrl as ReturnType<
      typeof vi.fn
    >;
    const getTmdbPosterUrl = vi
      .spyOn(plexBasePosterManager as any, 'getTmdbPosterUrl')
      .mockResolvedValue('https://image.tmdb.org/t/p/original/abc.jpg');
    vi.spyOn(
      plexBasePosterManager as any,
      'getTmdbCachedPoster'
    ).mockResolvedValue(Buffer.from('tmdb-poster'));
    // Negative-control guard: if a regression ever re-routes this item to the
    // Plex branch, this makes it resolve fast off the cache instead of
    // falling through to a real axios download, so the test fails on the
    // getCurrentPosterUrl assertion below rather than timing out on network.
    vi.spyOn(plexBasePosterManager, 'getStoredBasePoster').mockResolvedValue(
      Buffer.from('should-not-be-used')
    );

    const result = await plexBasePosterManager.getBasePosterForOverlay(
      plexApi,
      testItem,
      'lib-1',
      'Shows',
      'show',
      posterSource,
      {}
    );

    expect(getTmdbPosterUrl).toHaveBeenCalledWith(123, 'show', 'en');
    expect(getCurrentPosterUrl).not.toHaveBeenCalled();
    expect(result.sourceUrl).toBe(
      'https://image.tmdb.org/t/p/original/abc.jpg'
    );
  });

  it('recovers the tracked original on a second run instead of throwing, when the fallback recorded basePosterSource:plex and the base cache is missing (fork#110)', async () => {
    // Documents why the recorded source must be honest: had the caller kept
    // basePosterSource:'tmdb' for an item actually served from Plex,
    // recoverOriginalPlexPoster's `metadata.basePosterSource !== 'plex'`
    // guard (PlexBasePosterManager.ts ~478) would return null unconditionally
    // and every run would throw 'Cannot use overlaid poster as base'.
    const testItem = item({
      Guid: [{ id: 'imdb://tt12736950' }, { id: 'tvdb://376900' }],
    });
    const posterSource = resolveBasePosterSource(
      testItem,
      settingsWith('tmdb')
    );
    expect(posterSource).toBe('plex');

    // Plex is currently showing our overlay...
    const ourOverlayUrl = 'https://plex.local/library/metadata/123/thumb/999';
    const plexApi = plexApiStub(ourOverlayUrl);

    // ...and the base-poster cache for it is gone.
    vi.spyOn(plexBasePosterManager, 'getStoredBasePoster').mockResolvedValue(
      null
    );
    const storeBasePoster = vi
      .spyOn(plexBasePosterManager, 'storeBasePoster')
      .mockResolvedValue('recovered.webp');

    const recoveredBytes = Buffer.from('recovered-original-bytes');
    const axiosGet = vi.spyOn(axios, 'get').mockResolvedValue({
      headers: { 'content-type': 'image/webp' },
      data: recoveredBytes,
    });

    const trackedOriginal =
      'http://plex/library/metadata/123/file?url=upload%3A%2F%2Fposters%2Fabc';

    const result = await plexBasePosterManager.getBasePosterForOverlay(
      plexApi,
      testItem,
      'lib-1',
      'Shows',
      'show',
      posterSource,
      {
        basePosterSource: 'plex',
        originalPlexPosterUrl: trackedOriginal,
        ourOverlayPosterUrl: ourOverlayUrl,
      }
    );

    // Exact request recoverOriginalPlexPoster builds (PlexBasePosterManager.ts
    // ~493-500): mocked settings.plex {ip:127.0.0.1, port:32400, useSsl:false}
    // + the upload:// ref extracted from trackedOriginal, encoded, plus the
    // stubbed plexApi's plexToken.
    expect(axiosGet).toHaveBeenCalledWith(
      'http://127.0.0.1:32400/library/metadata/123/file?url=upload%3A%2F%2Fposters%2Fabc&X-Plex-Token=test-token',
      { responseType: 'arraybuffer', timeout: 30000 }
    );

    expect(storeBasePoster).toHaveBeenCalledTimes(1);
    const [storedBuffer, storedLibraryId, storedRatingKey] =
      storeBasePoster.mock.calls[0];
    expect(Buffer.isBuffer(storedBuffer)).toBe(true);
    expect((storedBuffer as Buffer).equals(recoveredBytes)).toBe(true);
    expect(storedLibraryId).toBe('lib-1');
    expect(storedRatingKey).toBe('123');

    expect(result.posterBuffer.toString()).toBe(recoveredBytes.toString());
    expect(result.sourceUrl).toBe(trackedOriginal);
  });
});

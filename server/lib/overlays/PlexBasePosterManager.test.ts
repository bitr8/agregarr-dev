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

// For exercising fetchTmdbPosterUrl's own catch block directly (fork#110
// rework) - needs the TMDB client itself to reject, not just its wrapper.
const { mockGetMovieImages, mockGetTvShowImages } = vi.hoisted(() => ({
  mockGetMovieImages: vi.fn(),
  mockGetTvShowImages: vi.fn(),
}));
vi.mock('@server/api/themoviedb', () => ({
  default: vi.fn().mockImplementation(function TheMovieDbMock(this: any) {
    this.getMovieImages = mockGetMovieImages;
    this.getTvShowImages = mockGetTvShowImages;
  }),
}));

import {
  plexBasePosterManager,
  resolveBasePosterSource,
  resolveBasePosterSourceWithTrail,
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

  it('falls back to Plex when TMDB has the item but no poster (fork#110)', async () => {
    const testItem = item({ Guid: [{ id: 'tmdb://456' }] });
    const posterSource = resolveBasePosterSource(
      testItem,
      settingsWith('tmdb')
    );
    // The resolver can't know TMDB has no poster until we actually ask it -
    // that's why the fallback lives inside getBasePosterForOverlay, not here.
    expect(posterSource).toBe('tmdb');

    const plexUrl = 'https://plex.local/library/metadata/123/thumb/5';
    const plexApi = plexApiStub(plexUrl);

    const getTmdbPosterUrl = vi
      .spyOn(plexBasePosterManager as any, 'getTmdbPosterUrl')
      .mockResolvedValue(undefined);

    vi.spyOn(plexBasePosterManager, 'getStoredBasePoster').mockResolvedValue(
      Buffer.from('plex-fallback-poster')
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

    expect(getTmdbPosterUrl).toHaveBeenCalledWith(456, 'show', 'en');
    expect(result.sourceUrl).toBe(plexUrl);
    expect(result.posterBuffer.toString()).toBe('plex-fallback-poster');
  });

  it('falls back to Plex when posterSource is tmdb but no TMDB id resolves', async () => {
    const testItem = item({ Guid: undefined });
    const plexUrl = 'https://plex.local/library/metadata/123/thumb/7';
    const plexApi = plexApiStub(plexUrl);

    vi.spyOn(plexBasePosterManager, 'getStoredBasePoster').mockResolvedValue(
      Buffer.from('plex-fallback-poster')
    );

    const result = await plexBasePosterManager.getBasePosterForOverlay(
      plexApi,
      testItem,
      'lib-1',
      'Shows',
      'show',
      'tmdb',
      {}
    );

    expect(result.sourceUrl).toBe(plexUrl);
  });

  it('does not fall back to Plex when the TMDB lookup errors', async () => {
    const testItem = item({ Guid: [{ id: 'tmdb://789' }] });
    const posterSource = resolveBasePosterSource(
      testItem,
      settingsWith('tmdb')
    );
    expect(posterSource).toBe('tmdb');

    const plexApi = plexApiStub('https://plex.local/should-not-be-used');
    const getCurrentPosterUrl = plexApi.getCurrentPosterUrl as ReturnType<
      typeof vi.fn
    >;

    // Real getTmdbPosterUrl/fetchTmdbPosterUrl chain, only the TMDB client
    // itself is mocked - this is the layer that actually changed. testItem
    // defaults to type 'show', so the TV branch is what fires.
    mockGetTvShowImages.mockRejectedValueOnce(
      new Error('TMDB request timed out')
    );

    await expect(
      plexBasePosterManager.getBasePosterForOverlay(
        plexApi,
        testItem,
        'lib-1',
        'Shows',
        'show',
        posterSource,
        {}
      )
    ).rejects.toThrow('TMDB request timed out');

    // No silent fallback: the Plex branch was never entered.
    expect(getCurrentPosterUrl).not.toHaveBeenCalled();
  });

  it('names TMDB then Plex when TMDB has the item but no poster and Plex has none', async () => {
    const testItem = item({ Guid: [{ id: 'tmdb://456' }] });
    vi.spyOn(
      plexBasePosterManager as any,
      'getTmdbPosterUrl'
    ).mockResolvedValue(undefined);

    await expect(
      plexBasePosterManager.getBasePosterForOverlay(
        plexApiStub(null),
        testItem,
        'lib-1',
        'Shows',
        'show',
        'tmdb',
        {}
      )
    ).rejects.toThrow(
      'No base poster available. Tried: TMDB (no poster on TMDB), Plex (item has no poster in Plex)'
    );
  });

  it('names the missing TMDB id and Plex when neither source has a poster', async () => {
    await expect(
      plexBasePosterManager.getBasePosterForOverlay(
        plexApiStub(null),
        item({ Guid: [{ id: 'imdb://tt0000001' }] }),
        'lib-1',
        'Shows',
        'show',
        'tmdb',
        {}
      )
    ).rejects.toThrow(
      'Tried: TMDB (item has no TMDB id), Plex (item has no poster in Plex)'
    );
  });

  it('names only Plex when Plex is the configured source', async () => {
    await expect(
      plexBasePosterManager.getBasePosterForOverlay(
        plexApiStub(null),
        item(),
        'lib-1',
        'Shows',
        'show',
        'plex',
        {}
      )
    ).rejects.toThrow('Tried: Plex (item has no poster in Plex)');
  });

  it('carries the resolver fallback reason into the error when TMDB is configured but the item has no TMDB guid', async () => {
    const testItem = item({ Guid: [{ id: 'imdb://tt0000001' }] });
    const { source, tried } = resolveBasePosterSourceWithTrail(
      testItem,
      settingsWith('tmdb')
    );
    expect(source).toBe('plex');

    await expect(
      plexBasePosterManager.getBasePosterForOverlay(
        plexApiStub(null),
        testItem,
        'lib-1',
        'Shows',
        'show',
        source,
        {},
        undefined,
        tried
      )
    ).rejects.toThrow(
      'Tried: TMDB (item has no TMDB id), Plex (item has no poster in Plex)'
    );
  });

  it('lists the local folder first when local, TMDB and Plex all come up empty', async () => {
    const testItem = item({ Guid: [{ id: 'tmdb://456' }] });
    vi.spyOn(
      plexBasePosterManager as any,
      'buildLocalPosterPath'
    ).mockResolvedValue('/tmp/none');
    vi.spyOn(plexBasePosterManager as any, 'scanLocalPoster').mockResolvedValue(
      {
        posterBuffer: null,
        fileModTime: null,
        fileChanged: false,
      }
    );
    vi.spyOn(
      plexBasePosterManager as any,
      'getTmdbPosterUrl'
    ).mockResolvedValue(undefined);

    await expect(
      plexBasePosterManager.getBasePosterForOverlay(
        plexApiStub(null),
        testItem,
        'lib-1',
        'Shows',
        'show',
        'local',
        {},
        456
      )
    ).rejects.toThrow(
      'Tried: local folder (no poster file found), TMDB (no poster on TMDB), Plex (item has no poster in Plex)'
    );
  });

  it('says a rejected local file is invalid rather than missing', async () => {
    vi.spyOn(
      plexBasePosterManager as any,
      'buildLocalPosterPath'
    ).mockResolvedValue('/tmp/none');
    vi.spyOn(plexBasePosterManager as any, 'scanLocalPoster').mockResolvedValue(
      {
        posterBuffer: null,
        fileModTime: null,
        fileChanged: false,
        rejected: true,
      }
    );
    vi.spyOn(
      plexBasePosterManager as any,
      'getTmdbPosterUrl'
    ).mockResolvedValue(undefined);

    await expect(
      plexBasePosterManager.getBasePosterForOverlay(
        plexApiStub(null),
        item({ Guid: [{ id: 'tmdb://456' }] }),
        'lib-1',
        'Shows',
        'show',
        'local',
        {},
        456
      )
    ).rejects.toThrow('local folder (poster file invalid or unreadable)');
  });

  it('fetchTmdbPosterUrl rethrows lookup errors instead of caching them as no poster', async () => {
    mockGetMovieImages.mockRejectedValueOnce(new Error('401 Unauthorized'));

    await expect(
      (plexBasePosterManager as any).fetchTmdbPosterUrl(999, 'movie', 'en')
    ).rejects.toThrow('401 Unauthorized');
  });

  it('refuses to adopt a marked overlay as the base when tracking is missing', async () => {
    const testItem = item({ Guid: [{ id: 'tmdb://123' }] });
    const overlayUrl = 'https://plex.local/library/metadata/123/thumb/9';
    const plexApi = plexApiStub(overlayUrl);

    vi.spyOn(plexBasePosterManager, 'getStoredBasePoster').mockResolvedValue(
      null
    );
    const storeBasePoster = vi
      .spyOn(plexBasePosterManager, 'storeBasePoster')
      .mockResolvedValue('should-not-be-stored.jpg');
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: Buffer.from('fake jpeg bytes overlay applied by Agregarr trailer'),
    });

    // No tracking at all - simulates the upload succeeding while the metadata
    // write that would have recorded ourOverlayPosterUrl failed.
    await expect(
      plexBasePosterManager.getBasePosterForOverlay(
        plexApi,
        testItem,
        'lib-1',
        'Shows',
        'show',
        'plex',
        {}
      )
    ).rejects.toThrow(
      'it appears to be our own overlay and no original poster is tracked'
    );

    expect(storeBasePoster).not.toHaveBeenCalled();
  });

  it('keeps the tried sources on the own-overlay failure', async () => {
    const plexApi = plexApiStub(
      'https://plex.local/library/metadata/123/thumb/9'
    );
    vi.spyOn(plexBasePosterManager, 'getStoredBasePoster').mockResolvedValue(
      null
    );
    vi.spyOn(plexBasePosterManager, 'storeBasePoster').mockResolvedValue(
      'x.jpg'
    );
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: Buffer.from('fake jpeg bytes overlay applied by Agregarr trailer'),
    });

    await expect(
      plexBasePosterManager.getBasePosterForOverlay(
        plexApi,
        item({ Guid: [{ id: 'tmdb://123' }] }),
        'lib-1',
        'Shows',
        'show',
        'plex',
        {},
        undefined,
        ['TMDB (no poster on TMDB)']
      )
    ).rejects.toThrow(
      /no original poster is tracked.*\(Sources tried: TMDB \(no poster on TMDB\)\)/
    );
  });

  it('fails closed on cache loss when a fallback item is recorded as tmdb', async () => {
    // This is the failure-mode this rework accepts on purpose: the caller
    // records posterSource ('tmdb'), not what getBasePosterForOverlay actually
    // used. So when the cache is lost and Plex still shows our overlay,
    // recoverOriginalPlexPoster's `metadata.basePosterSource !== 'plex'` guard
    // (PlexBasePosterManager.ts ~438) refuses recovery - it fails closed with
    // a loud error rather than risk compositing the overlay onto itself.
    const testItem = item({ Guid: [{ id: 'tmdb://456' }] });

    const ourOverlayUrl = 'https://plex.local/library/metadata/123/thumb/999';
    const plexApi = plexApiStub(ourOverlayUrl);

    vi.spyOn(plexBasePosterManager, 'getStoredBasePoster').mockResolvedValue(
      null
    );
    const axiosGet = vi.spyOn(axios, 'get');

    await expect(
      plexBasePosterManager.getBasePosterForOverlay(
        plexApi,
        testItem,
        'lib-1',
        'Shows',
        'show',
        'plex', // as if getBasePosterForOverlay had fallen back to plex before
        {
          basePosterSource: 'tmdb', // ...but the caller recorded the requested source
          originalPlexPosterUrl:
            'http://plex/library/metadata/123/file?url=upload%3A%2F%2Fposters%2Fabc',
          ourOverlayPosterUrl: ourOverlayUrl,
        }
      )
    ).rejects.toThrow('Cannot use overlaid poster as base');

    // Fails closed before ever attempting the recovery download.
    expect(axiosGet).not.toHaveBeenCalled();
  });
});

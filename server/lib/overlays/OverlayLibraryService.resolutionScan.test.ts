import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpisodeMediaCacheService as RealCacheService } from './EpisodeMediaCacheService';
import type {
  AggregatedMediaInfo,
  EpisodeMediaInfo,
} from './episodeMediaTypes';

vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({ plex: { machineId: 'srv' } }),
}));

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));

vi.mock(
  '@server/lib/collections/services/PreExistingCollectionConfigService',
  () => ({
    preExistingCollectionConfigService: { getConfigs: () => [] },
  })
);

vi.mock('@server/lib/placeholders/services/PlaceholderContextService', () => ({
  placeholderContextService: {
    isPlaceholderItemAsync: () => Promise.resolve(false),
  },
}));

const state = vi.hoisted(() => ({
  fresh: [] as EpisodeMediaInfo[],
  cached: [] as EpisodeMediaInfo[],
  saved: [] as unknown[][],
  trailers: [] as string[],
  deleted: [] as string[],
}));

vi.mock('./PlexEpisodeMediaScanner', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PlexEpisodeMediaScanner: class {
    trailerRatingKeys = state.trailers;
    scanLibraryEpisodes = () => Promise.resolve(state.fresh);
  },
}));

vi.mock('./EpisodeMediaCacheService', async (importOriginal) => {
  const actual = await importOriginal<{
    EpisodeMediaCacheService: typeof RealCacheService;
  }>();
  return {
    ...actual,
    EpisodeMediaCacheService: class extends actual.EpisodeMediaCacheService {
      getCachedEpisodes = () => Promise.resolve({ episodes: state.cached });
      saveEpisodes = (_s: string, _l: string, eps: unknown[]) => {
        state.saved.push(eps);
        return Promise.resolve();
      };
      deleteEpisodes = (_s: string, _l: string, keys: string[]) => {
        state.deleted.push(...keys);
        state.cached = state.cached.filter((c) => !keys.includes(c.ratingKey));
        return Promise.resolve();
      };
      cleanExpired = () => Promise.resolve();
    },
  };
});

import { overlayLibraryService } from './OverlayLibraryService';

type Internals = {
  runEpisodeScan: (
    plexApi: unknown,
    libraryId: string,
    required: Set<string>,
    showPoster: Set<string>
  ) => Promise<void>;
  aggregatedMediaByLibrary: Map<string, Map<string, AggregatedMediaInfo>>;
};
const svc = overlayLibraryService as unknown as Internals;

const row = (
  ratingKey: string,
  over: Partial<EpisodeMediaInfo> = {}
): EpisodeMediaInfo => ({
  ratingKey,
  showRatingKey: 'show-1',
  seasonRatingKey: 'season-1',
  seasonNumber: 1,
  episodeNumber: 1,
  resolution: '1080',
  hdr: false,
  dolbyVision: false,
  hdr10Plus: false,
  videoCodec: 'h264',
  audioCodec: 'aac',
  audioChannels: 2,
  bitDepth: 8,
  mediaHash: `hash-${ratingKey}`,
  versionCount: 1,
  hasStreamDetail: false,
  addedAt: 100,
  ...over,
});

const savedResolutions = () =>
  Object.fromEntries(
    (state.saved.at(-1) as EpisodeMediaInfo[]).map((e) => [
      e.ratingKey,
      e.resolution,
    ])
  );

beforeEach(() => {
  state.saved = [];
  state.trailers = [];
  state.deleted = [];
  svc.aggregatedMediaByLibrary.clear();
});

describe('runEpisodeScan refreshes cached resolution from the list scan', () => {
  it('resaves when every row is cached and fresh but a resolution differs', async () => {
    state.fresh = [
      row('a', { resolution: '720' }),
      row('b', { resolution: '1080' }),
    ];
    state.cached = [
      row('a', { resolution: 'sd' }),
      row('b', { resolution: '1080' }),
    ];

    await svc.runEpisodeScan({}, 'lib', new Set(), new Set());

    expect(state.saved).toHaveLength(1);
    expect(savedResolutions()).toEqual({ a: '720', b: '1080' });
  });

  it('does not resave when the cache already agrees', async () => {
    state.fresh = [row('a', { resolution: '720' })];
    state.cached = [row('a', { resolution: '720' })];

    await svc.runEpisodeScan({}, 'lib', new Set(), new Set());

    expect(state.saved).toHaveLength(0);
  });

  it('does not let a list unknown flip a cached detailed row', async () => {
    state.fresh = [row('a', { resolution: 'unknown' })];
    state.cached = [
      row('a', { resolution: '1080', hasStreamDetail: true, hdr: true }),
    ];

    await svc.runEpisodeScan({}, 'lib', new Set(), new Set());

    expect(state.saved).toHaveLength(0);
    expect(
      svc.aggregatedMediaByLibrary.get('lib')?.get('show-1')
        ?.episodeUnknownResolutionCount
    ).toBe(0);
  });

  it('keeps a just-fetched detail resolution when the list says unknown', async () => {
    state.fresh = [row('b', { resolution: 'unknown', mediaHash: 'changed' })];
    state.cached = [row('b', { resolution: '1080' })];
    const batch = new Map([
      [
        'b',
        {
          Media: [
            {
              videoResolution: '1080',
              Part: [{ Stream: [{ streamType: 1, bitDepth: 10 }] }],
            },
          ],
        },
      ],
    ]);

    await svc.runEpisodeScan(
      { getMetadataBatch: () => Promise.resolve(batch) },
      'lib',
      new Set(['hdr']),
      new Set()
    );

    expect(savedResolutions()).toEqual({ b: '1080' });
  });

  it('refreshes reused cached rows in the stream-detail pass without refetching them', async () => {
    const fetched: string[][] = [];
    state.fresh = [
      row('a', { resolution: '720' }),
      row('b', { mediaHash: 'changed' }),
    ];
    state.cached = [
      row('a', { resolution: 'sd', hasStreamDetail: true, hdr: true }),
      row('b', { hasStreamDetail: false }),
    ];

    await svc.runEpisodeScan(
      {
        getMetadataBatch: (keys: string[]) => {
          fetched.push(keys);
          return Promise.resolve(new Map());
        },
      },
      'lib',
      new Set(['hdr']),
      new Set()
    );

    expect(fetched).toEqual([['b']]);
    const a = (state.saved.at(-1) as EpisodeMediaInfo[]).find(
      (e) => e.ratingKey === 'a'
    );
    expect(a?.resolution).toBe('720');
    expect(a?.hdr).toBe(true);
    expect(a?.hasStreamDetail).toBe(true);
  });

  it('keeps cached stream detail and takes the fresh resolution on a lightweight save', async () => {
    state.fresh = [
      row('a', { resolution: '720' }),
      row('c', { resolution: '720' }),
    ];
    state.cached = [
      row('a', { resolution: 'sd', hasStreamDetail: true, hdr: true }),
    ];

    await svc.runEpisodeScan({}, 'lib', new Set(), new Set());

    const a = (state.saved.at(-1) as EpisodeMediaInfo[]).find(
      (e) => e.ratingKey === 'a'
    );
    expect(a?.hdr).toBe(true);
    expect(a?.resolution).toBe('720');
  });
});

describe('runEpisodeScan trailer placeholder rows', () => {
  it('deletes exactly the reported trailer rows and stops counting them', async () => {
    state.fresh = [row('a', { resolution: '1080' })];
    state.trailers = ['t'];
    state.cached = [
      row('a', { resolution: '1080' }),
      row('t', { resolution: '1080', seasonNumber: 0 }),
      row('gone', { resolution: '1080' }),
    ];

    await svc.runEpisodeScan({}, 'lib', new Set(), new Set());

    expect(state.deleted).toEqual(['t']);
    expect(state.cached.map((c) => c.ratingKey)).toEqual(['a', 'gone']);
    const fromCache = await overlayLibraryService.getAggregatedMediaFromCache(
      'lib2'
    );
    expect(fromCache?.get('show-1')?.episodeCount).toBe(2);
  });

  it('leaves the trailer row alone when the scan throws part-way', async () => {
    state.fresh = [row('a', { resolution: '1080', mediaHash: 'changed' })];
    state.trailers = ['t'];
    state.cached = [row('a'), row('t', { seasonNumber: 0 })];

    await expect(
      svc.runEpisodeScan(
        { getMetadataBatch: () => Promise.reject(new Error('plex down')) },
        'lib',
        new Set(['hdr']),
        new Set()
      )
    ).rejects.toThrow('plex down');

    expect(state.deleted).toEqual([]);
    expect(state.cached.map((c) => c.ratingKey)).toEqual(['a', 't']);
  });
});

describe('runEpisodeScan detail without a resolution', () => {
  const noResolutionBatch = new Map([
    [
      'b',
      {
        Media: [{ Part: [{ Stream: [{ streamType: 1, bitDepth: 10 }] }] }],
      },
    ],
  ]);
  const run = (listRes: string, cachedRes: string) => {
    state.fresh = [row('b', { resolution: listRes, mediaHash: 'changed' })];
    state.cached = [row('b', { resolution: cachedRes })];
    return svc.runEpisodeScan(
      { getMetadataBatch: () => Promise.resolve(noResolutionBatch) },
      'lib',
      new Set(['hdr']),
      new Set()
    );
  };

  it('takes the list value over the cached one', async () => {
    await run('1080', '720');
    expect(savedResolutions()).toEqual({ b: '1080' });
  });

  it('falls back to the cached value when the list is unknown too', async () => {
    await run('unknown', '720');
    expect(savedResolutions()).toEqual({ b: '720' });
  });
});

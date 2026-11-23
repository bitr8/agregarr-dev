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
}));

vi.mock('./PlexEpisodeMediaScanner', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PlexEpisodeMediaScanner: class {
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
  svc.aggregatedMediaByLibrary.clear();
});

describe('runEpisodeScan refreshes cached resolution from the list scan', () => {
  it('resaves when every row is cached and fresh but a resolution differs', async () => {
    state.fresh = [
      row('a', { resolution: 'unknown' }),
      row('b', { resolution: '720' }),
    ];
    state.cached = [
      row('a', { resolution: 'sd' }),
      row('b', { resolution: '720' }),
    ];

    await svc.runEpisodeScan({}, 'lib', new Set(), new Set());

    expect(state.saved).toHaveLength(1);
    expect(savedResolutions()).toEqual({ a: 'unknown', b: '720' });
    expect(
      svc.aggregatedMediaByLibrary.get('lib')?.get('show-1')
        ?.episodeUnknownResolutionCount
    ).toBe(1);
  });

  it('does not resave when the cache already agrees', async () => {
    state.fresh = [row('a', { resolution: 'unknown' })];
    state.cached = [row('a', { resolution: 'unknown' })];

    await svc.runEpisodeScan({}, 'lib', new Set(), new Set());

    expect(state.saved).toHaveLength(0);
  });

  it('refreshes reused cached rows in the stream-detail pass without refetching them', async () => {
    const fetched: string[][] = [];
    state.fresh = [
      row('a', { resolution: 'unknown' }),
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
    expect(a?.resolution).toBe('unknown');
    expect(a?.hdr).toBe(true);
    expect(a?.hasStreamDetail).toBe(true);
  });

  it('keeps cached stream detail and takes the fresh resolution on a lightweight save', async () => {
    state.fresh = [
      row('a', { resolution: 'unknown' }),
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
    expect(a?.resolution).toBe('unknown');
  });
});

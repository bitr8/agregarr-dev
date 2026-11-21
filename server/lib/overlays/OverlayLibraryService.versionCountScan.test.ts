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
  hasStreamDetail: false,
  addedAt: 100,
  ...over,
});

const savedVersionCounts = () =>
  Object.fromEntries(
    (state.saved.at(-1) as EpisodeMediaInfo[]).map((e) => [
      e.ratingKey,
      e.versionCount,
    ])
  );

beforeEach(() => {
  state.saved = [];
  svc.aggregatedMediaByLibrary.clear();
});

describe('runEpisodeScan picks up version counts for cache rows that predate the column', () => {
  it('resaves when every row is cached and fresh', async () => {
    state.fresh = [
      row('a', { versionCount: 2 }),
      row('b', { versionCount: 1 }),
    ];
    state.cached = [
      row('a', { versionCount: null }),
      row('b', { versionCount: null }),
    ];

    await svc.runEpisodeScan({}, 'lib', new Set(), new Set());

    expect(state.saved).toHaveLength(1);
    expect(savedVersionCounts()).toEqual({ a: 2, b: 1 });
    expect(
      svc.aggregatedMediaByLibrary.get('lib')?.get('show-1')
        ?.episodeMultiVersionCount
    ).toBe(1);
  });

  it('does not resave when the cache already agrees', async () => {
    state.fresh = [row('a', { versionCount: 2 })];
    state.cached = [row('a', { versionCount: 2 })];

    await svc.runEpisodeScan({}, 'lib', new Set(), new Set());

    expect(state.saved).toHaveLength(0);
  });

  it('merges the count into cached rows reused by the stream-detail pass', async () => {
    state.fresh = [
      row('a', { versionCount: 2 }),
      row('b', { versionCount: 1, mediaHash: 'changed' }),
    ];
    state.cached = [
      row('a', { versionCount: null, hasStreamDetail: true }),
      row('b', { versionCount: null }),
    ];

    await svc.runEpisodeScan(
      { getMetadataBatch: () => Promise.resolve(new Map()) },
      'lib',
      new Set(['hdr']),
      new Set()
    );

    expect(savedVersionCounts()).toEqual({ a: 2, b: 1 });
    const a = (state.saved.at(-1) as EpisodeMediaInfo[]).find(
      (e) => e.ratingKey === 'a'
    );
    expect(a?.hasStreamDetail).toBe(true);
  });

  it('saves the fresh count when new episodes arrive', async () => {
    state.fresh = [
      row('a', { versionCount: 2 }),
      row('c', { versionCount: 1 }),
    ];
    state.cached = [row('a', { versionCount: 1 })];

    await svc.runEpisodeScan({}, 'lib', new Set(), new Set());

    expect(savedVersionCounts()).toEqual({ a: 2, c: 1 });
  });
});

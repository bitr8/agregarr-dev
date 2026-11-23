process.env.TZ = 'Australia/Sydney';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetSettings } = vi.hoisted(() => ({ mockGetSettings: vi.fn() }));
vi.mock('@server/lib/settings', async (importOriginal) => {
  const actual = await importOriginal<{ getSettings: () => unknown }>();
  return {
    ...actual,
    getSettings: () => mockGetSettings() ?? actual.getSettings(),
  };
});

vi.mock('@server/datasource', () => ({
  getRepository: () => ({ findOne: vi.fn(), findByIds: vi.fn() }),
}));

vi.mock('@server/lib/metadata/MetadataTrackingService', () => ({
  default: { getItemMetadata: () => Promise.resolve(undefined) },
}));

const mockGetTvShow = vi.fn();
vi.mock('@server/api/themoviedb', () => ({
  default: class {
    getTvShow = mockGetTvShow;
  },
}));

const mockGetSeries = vi.fn();
const mockGetEpisodes = vi.fn();
const mockGetEpisodeFile = vi.fn();
vi.mock('@server/api/servarr/sonarr', () => ({
  default: class {
    getSeries = mockGetSeries;
    getEpisodesBySeries = mockGetEpisodes;
    getEpisodeFile = mockGetEpisodeFile;
    getTags = () => Promise.resolve([]);
  },
}));

const mockHash = vi.fn();
vi.mock('@server/utils/metadataHashing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  calculateOverlayInputHash: (config: unknown) => mockHash(config),
}));

import type { calculateOverlayInputHash } from '@server/utils/metadataHashing';
import { overlayLibraryService } from './OverlayLibraryService';
import { evaluateCondition } from './OverlayTemplateRenderer';
import { PRESET_TEMPLATES } from './PresetTemplates';

type Internals = {
  applyOverlaysToItem: (...args: unknown[]) => Promise<unknown>;
  requiredContextFieldsByLibrary: Map<string, Set<string>>;
  sonarrSeriesCache?: Map<string, unknown>;
};
const svc = overlayLibraryService as unknown as Internals;

const realHash = (
  vi.importActual('@server/utils/metadataHashing') as Promise<{
    calculateOverlayInputHash: typeof calculateOverlayInputHash;
  }>
).then((m) => m.calculateOverlayInputHash);

// Yellowjackets, live TMDB and Sonarr 22/11/2026.
const TMDB_SHOW = {
  name: 'Yellowjackets',
  first_air_date: '2021-11-14',
  external_ids: { tvdb_id: 399731 },
  next_episode_to_air: {
    season_number: 4,
    episode_number: 1,
    air_date: '2026-11-22',
  },
  seasons: [{ season_number: 4, air_date: '2026-11-22' }],
};
const EPISODES = [
  { seasonNumber: 4, episodeNumber: 1, airDateUtc: '2026-11-23T02:00:00Z' },
  { seasonNumber: 4, episodeNumber: 2, airDateUtc: '2026-11-30T02:00:00Z' },
];

const templateReading = (field: string) => ({
  id: 1,
  getTags: () => ['main'],
  getTemplateData: () => ({
    elements: [
      {
        type: 'variable',
        properties: { segments: [{ type: 'variable', field }] },
      },
    ],
  }),
  getApplicationCondition: () => null,
});

const show = {
  ratingKey: '10',
  type: 'show',
  title: 'Yellowjackets',
  guid: 'plex://show/1',
  Guid: [{ id: 'tmdb://117488' }],
  Media: [],
  addedAt: 1_700_000_000,
  updatedAt: 1_700_000_100,
  childCount: 4,
};

const run = async (fieldOrFields: string | string[]) => {
  const fields = [fieldOrFields].flat();
  const field = fields[0];
  svc.requiredContextFieldsByLibrary.set('lib', new Set(fields));
  mockHash.mockImplementation((config: unknown) => {
    throw Object.assign(new Error('captured'), { config });
  });
  mockHash.mockClear();
  const result = await svc
    .applyOverlaysToItem(
      {},
      { ...show },
      [templateReading(field)],
      'show',
      'lib',
      'Lib',
      undefined,
      { fallback: false }
    )
    .catch(() => undefined);
  const config = mockHash.mock.calls[0]?.[0] as
    | { context: Record<string, unknown> }
    | undefined;
  return { result, config };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-23T03:00:00Z')); // 14:00 AEDT
  svc.sonarrSeriesCache = new Map();
  mockGetSettings.mockReturnValue({
    plex: { collectionConfigs: [], libraries: [] },
    sonarr: [{ hostname: 'sonarr', port: 8989, useSsl: false, apiKey: 'k' }],
    overlays: {},
  });
  mockGetTvShow.mockResolvedValue(TMDB_SHOW);
  mockGetSeries.mockResolvedValue([{ id: 66, tvdbId: 399731 }]);
  mockGetEpisodes.mockResolvedValue(EPISODES);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  svc.requiredContextFieldsByLibrary.delete('lib');
});

describe('Sonarr episode fields on show posters', () => {
  it('puts the summary into the render context', async () => {
    const { config } = await run('episodesAiringToday');
    expect(config?.context).toMatchObject({
      episodesAiringToday: 1,
      todayEpisodeNumber: 1,
      daysSinceLastAiredEpisode: 0,
    });
  });

  it('makes no episode-list calls for a library that reads none of the fields', async () => {
    const { config } = await run('title');
    expect(config).toBeDefined();
    expect(mockGetEpisodes).not.toHaveBeenCalled();
    expect(config?.context.episodesAiringToday).toBeUndefined();
  });

  it('skips the item and keeps its poster when the episode list fails', async () => {
    mockGetEpisodes.mockRejectedValue(new Error('sonarr down'));
    const { result, config } = await run('episodesAiringToday');
    expect(result).toEqual({ skipped: true });
    expect(config).toBeUndefined();
  });

  it('changes the hash at local midnight for a template reading the field', async () => {
    const hash = await realHash;
    const before = await run('episodesAiringToday');
    vi.setSystemTime(new Date('2026-11-23T13:01:00Z')); // 24/11 00:01 AEDT
    svc.sonarrSeriesCache = new Map();
    const after = await run('episodesAiringToday');
    expect(before.config?.context.episodesAiringToday).toBe(1);
    expect(after.config?.context.episodesAiringToday).toBe(0);
    expect(hash(after.config as never)).not.toBe(hash(before.config as never));
  });
});

describe('scheduled air dates and call budget', () => {
  const PREMIERE = '2026-11-23T02:00:00Z';
  const E2 = '2026-11-30T02:00:00Z';
  const early = [
    {
      seasonNumber: 4,
      episodeNumber: 1,
      airDateUtc: PREMIERE,
      hasFile: true,
      episodeFileId: 501,
    },
    { seasonNumber: 4, episodeNumber: 2, airDateUtc: E2, hasFile: false },
  ];

  beforeEach(() => {
    vi.setSystemTime(new Date('2026-11-22T12:45:00Z')); // 23:45 AEDT 22/11
    mockGetSeries.mockResolvedValue([
      { id: 66, tvdbId: 399731, monitored: true, nextAiring: PREMIERE },
    ]);
    mockGetEpisodes.mockResolvedValue(early);
    mockGetEpisodeFile.mockResolvedValue({
      dateAdded: '2026-11-20T08:16:27Z',
    });
  });

  it('makes no episode-list or file calls when no schedule field is read', async () => {
    const { config } = await run('title');
    expect(config).toBeDefined();
    expect(mockGetEpisodes).not.toHaveBeenCalled();
    expect(mockGetEpisodeFile).not.toHaveBeenCalled();
  });

  it('counts down to a premiere that already has a file, without any file lookup', async () => {
    const { config } = await run('daysUntilNextSeason');
    expect(config?.context).toMatchObject({
      daysUntilNextSeason: 1,
      nextSeasonAirDate: PREMIERE,
    });
    expect(mockGetEpisodes).toHaveBeenCalledTimes(1);
    expect(mockGetEpisodeFile).not.toHaveBeenCalled();
  });

  it('one list and no file lookups for the Sonarr episode fields', async () => {
    await run(['episodesAiringToday', 'nextSeasonDownloaded']);
    expect(mockGetEpisodes).toHaveBeenCalledTimes(1);
    expect(mockGetEpisodeFile).not.toHaveBeenCalled();
  });

  it('flags the early premiere and Returning Tomorrow stays off the poster', async () => {
    const fields = [
      'daysUntilNextSeason',
      'seasonNumber',
      'mediaType',
      'inSonarr',
      'isMonitored',
      'nextSeasonDownloaded',
    ];
    const tomorrow = PRESET_TEMPLATES.find(
      (p) => p.name === 'Returning Tomorrow (Monitored)'
    );
    const downloaded = await run(fields);
    expect(downloaded.config?.context).toMatchObject({
      daysUntilNextSeason: 1,
      nextSeasonDownloaded: true,
      seasonNumber: 4,
    });
    expect(
      evaluateCondition(
        tomorrow?.applicationCondition,
        downloaded.config?.context as never
      )
    ).toBe(false);

    mockGetEpisodes.mockResolvedValue([
      { ...early[0], hasFile: false },
      early[1],
    ]);
    svc.sonarrSeriesCache = new Map();
    const missing = await run(fields);
    expect(missing.config?.context.nextSeasonDownloaded).toBe(false);
    expect(
      evaluateCondition(
        tomorrow?.applicationCondition,
        missing.config?.context as never
      )
    ).toBe(true);
  });
});

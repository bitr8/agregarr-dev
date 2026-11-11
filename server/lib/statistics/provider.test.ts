import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  tracearr: undefined as Record<string, unknown> | undefined,
}));

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/entity/CollectionMetadata', () => ({
  CollectionMetadata: class {},
}));
vi.mock('@server/entity/CollectionMissingItems', () => ({
  CollectionMissingItems: class {},
}));
vi.mock('@server/entity/PosterTemplate', () => ({ PosterTemplate: class {} }));
vi.mock('@server/entity/User', () => ({ User: class {} }));
vi.mock('@server/entity/PlaceholderItem', () => ({
  PlaceholderItem: class {},
}));
vi.mock('@server/api/imdbRatings', () => ({ default: class {} }));
vi.mock('@server/lib/cache', () => ({ default: { getCache: vi.fn() } }));
vi.mock('@server/lib/posterStorage', () => ({ generatePoster: vi.fn() }));
vi.mock('@server/lib/placeholders/services/PlaceholderCleanup', () => ({
  handlePlaceholderCleanup: vi.fn(),
}));
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
    tracearr: state.tracearr,
    tautulli: { hostname: 'tautulli.example', apiKey: 't' },
    globalExclusions: { movies: [], tv: [], tvdb: [] },
    plex: { libraries: [{ key: '4', type: 'movie' }], collectionConfigs: [] },
    save: vi.fn(),
  }),
}));

import { collectionSyncService } from '@server/lib/collections/services/CollectionSyncService';
import { MultiSourceOrchestrator } from '@server/lib/collections/services/MultiSourceOrchestrator';
import { TautulliCollectionSync } from '@server/lib/collections/sources/tautulli';
import { TracearrStatsCollectionSync } from '@server/lib/collections/sources/tracearrStats';
import { getStatisticsProvider } from './provider';

const full = { enabled: true, hostname: 'tracearr.example', apiKey: 'k' };

const cases: [string, Record<string, unknown> | undefined, string][] = [
  ['undefined', undefined, 'tautulli'],
  ['empty object', {}, 'tautulli'],
  ['disabled', { ...full, enabled: false }, 'tautulli'],
  ['enabled without api key', { ...full, apiKey: undefined }, 'tautulli'],
  ['enabled without hostname', { ...full, hostname: undefined }, 'tautulli'],
  ['enabled and configured', full, 'tracearr'],
];

describe('getStatisticsProvider', () => {
  it.each(cases)('%s', (_name, tracearr, expected) => {
    state.tracearr = tracearr;
    expect(getStatisticsProvider()).toBe(expected);
  });
});

describe('tautulli factories', () => {
  beforeEach(() => {
    state.tracearr = undefined;
  });

  const orchestratorService = (o: MultiSourceOrchestrator) =>
    (o as unknown as { getSyncService: (t: string) => object }).getSyncService(
      'tautulli'
    );

  it.each(cases)('single-collection factory: %s', async (_n, tracearr, exp) => {
    state.tracearr = tracearr;
    const service = await collectionSyncService.createSyncService('tautulli');
    expect(service.constructor).toBe(
      exp === 'tracearr' ? TracearrStatsCollectionSync : TautulliCollectionSync
    );
  });

  it.each(cases)('multi-source factory: %s', (_n, tracearr, exp) => {
    state.tracearr = tracearr;
    expect(orchestratorService(new MultiSourceOrchestrator()).constructor).toBe(
      exp === 'tracearr' ? TracearrStatsCollectionSync : TautulliCollectionSync
    );
  });

  it('multi-source factory follows a runtime provider switch on one instance', () => {
    const orchestrator = new MultiSourceOrchestrator();
    expect(orchestratorService(orchestrator).constructor).toBe(
      TautulliCollectionSync
    );

    state.tracearr = full;
    expect(orchestratorService(orchestrator).constructor).toBe(
      TracearrStatsCollectionSync
    );

    state.tracearr = { ...full, enabled: false };
    expect(orchestratorService(orchestrator).constructor).toBe(
      TautulliCollectionSync
    );
  });
});

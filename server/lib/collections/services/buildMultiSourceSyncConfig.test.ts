import type { CollectionConfig } from '@server/lib/settings';
import { describe, expect, it, vi } from 'vitest';

// Mock the modules that trigger TypeORM entity loading (same set as
// CollectionUtilities.test.ts, since buildMultiSourceSyncConfig calls the
// real getCollectionMediaType()).
vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/entity/User', () => ({ User: class {} }));
vi.mock('@server/lib/collections/utils/TemplateEngine', () => ({
  templateEngine: {},
}));
vi.mock('@server/logger', () => ({
  default: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const settings = {
  plex: { libraries: [{ key: '4', type: 'movie' }] },
};

vi.mock('@server/lib/settings', () => ({
  getSettings: () => settings,
}));

import { buildMultiSourceSyncConfig } from './CollectionSyncService';

// Fork issue #88: the bulk CollectionSyncService sync path built the
// multi-source config from a hand-picked field list and dropped the seven
// direct-download tag/monitor/search-on-add fields, so tags configured in
// the UI silently never reached DirectDownloadService on this path.
const config = (overrides: Partial<CollectionConfig>): CollectionConfig =>
  ({
    id: 'cfg-1',
    name: 'Trending Movies This Week',
    type: 'multi-source',
    visibilityConfig: {
      usersHome: true,
      serverOwnerHome: true,
      libraryRecommended: false,
    },
    libraryId: '4',
    libraryName: 'Movies',
    maxItems: 50,
    template: 'DEFAULT',
    isActive: true,
    sources: [],
    combineMode: 'list_order',
    downloadMode: 'direct',
    // Radarr/Sonarr monitor+searchOnAdd deliberately set to opposite booleans
    // so a field swapped with its sibling (not just dropped) also goes red.
    directDownloadRadarrTags: [7],
    directDownloadRadarrMonitor: true,
    directDownloadRadarrSearchOnAdd: false,
    directDownloadSonarrTags: [9],
    directDownloadSonarrMonitor: false,
    directDownloadSonarrMonitorType: 'firstSeason',
    directDownloadSonarrSearchOnAdd: true,
    ...overrides,
  } as CollectionConfig);

describe('buildMultiSourceSyncConfig', () => {
  it('carries the direct-download tag/monitor/search-on-add fields through to the multi-source config', () => {
    const result = buildMultiSourceSyncConfig(config({}));

    expect(result.directDownloadRadarrTags).toEqual([7]);
    expect(result.directDownloadRadarrMonitor).toBe(true);
    expect(result.directDownloadRadarrSearchOnAdd).toBe(false);
    expect(result.directDownloadSonarrTags).toEqual([9]);
    expect(result.directDownloadSonarrMonitor).toBe(false);
    expect(result.directDownloadSonarrMonitorType).toBe('firstSeason');
    expect(result.directDownloadSonarrSearchOnAdd).toBe(true);
  });

  it('still applies the existing server/profile/root-folder overrides for both Radarr and Sonarr', () => {
    const result = buildMultiSourceSyncConfig(
      config({
        directDownloadRadarrServerId: 1,
        directDownloadRadarrProfileId: 2,
        directDownloadRadarrRootFolder: '/movies',
        directDownloadSonarrServerId: 11,
        directDownloadSonarrProfileId: 22,
        directDownloadSonarrRootFolder: '/tv',
      })
    );

    expect(result.directDownloadRadarrServerId).toBe(1);
    expect(result.directDownloadRadarrProfileId).toBe(2);
    expect(result.directDownloadRadarrRootFolder).toBe('/movies');
    expect(result.directDownloadSonarrServerId).toBe(11);
    expect(result.directDownloadSonarrProfileId).toBe(22);
    expect(result.directDownloadSonarrRootFolder).toBe('/tv');
  });

  it('carries every mapped source field through sources[] with distinct sentinels', () => {
    const result = buildMultiSourceSyncConfig(
      config({
        sources: [
          {
            id: 'src-1',
            type: 'radarrtag',
            subtype: 'radarrtag-subtype',
            customUrl: 'https://example.com/list',
            timePeriod: 'weekly',
            priority: 2,
            customDays: 14,
            minimumPlays: 3,
            networksCountry: 'AU',
            radarrTagServerId: 101,
            radarrTagId: 202,
            radarrTagLabel: 'radarr-label',
            sonarrTagServerId: 303,
            sonarrTagId: 404,
            sonarrTagLabel: 'sonarr-label',
            resolvedTitle: 'Resolved Title',
          },
        ],
      })
    );

    // Fork #88 review: this mapper is a hand-picked field list (unlike the
    // outer spread) and had zero coverage. Dropping radarrTagServerId (or
    // any other field here) must fail this assertion.
    expect(result.sources).toEqual([
      {
        id: 'src-1',
        type: 'radarrtag',
        subtype: 'radarrtag-subtype',
        customUrl: 'https://example.com/list',
        timePeriod: 'weekly',
        priority: 2,
        customDays: 14,
        minimumPlays: 3,
        networksCountry: 'AU',
        radarrTagServerId: 101,
        radarrTagId: 202,
        radarrTagLabel: 'radarr-label',
        sonarrTagServerId: 303,
        sonarrTagId: 404,
        sonarrTagLabel: 'sonarr-label',
        resolvedTitle: 'Resolved Title',
      },
    ]);
  });

  it('output key set is a superset of the input config key set (fails if the spread reverts to a field list)', () => {
    const input = config({});
    const result = buildMultiSourceSyncConfig(input);

    // This is the parity guard: reverting the function body to any
    // hand-picked literal (the exact shape of the bug this fix closes)
    // drops keys and fails here, independent of which fields the literal
    // happens to remember to list.
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining(Object.keys(input))
    );
  });

  it('still normalises type, mediaType, maxItems, template and combineMode', () => {
    const result = buildMultiSourceSyncConfig(
      config({ maxItems: undefined as unknown as number, template: '' })
    );

    expect(result.type).toBe('multi-source');
    expect(result.mediaType).toBe('movie');
    expect(result.maxItems).toBe(50);
    expect(result.template).toBe('');
    expect(result.combineMode).toBe('list_order');
  });
});

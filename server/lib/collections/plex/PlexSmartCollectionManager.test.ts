import type PlexAPI from '@server/api/plexapi';
import logger from '@server/logger';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockSettings = {
  plex: { machineId: 'test-machine-id' },
};
vi.mock('@server/lib/settings', () => ({
  getSettings: () => mockSettings,
}));

import PlexSmartCollectionManager, {
  mapSortOrderToPlexSort,
} from './PlexSmartCollectionManager';

function createManager() {
  const mockPlexApi = {
    safePostQuery: vi.fn().mockResolvedValue({
      MediaContainer: { Metadata: [{ ratingKey: '99999' }] },
    }),
    safePutQuery: vi.fn().mockResolvedValue(undefined),
    addLabelToCollection: vi.fn().mockResolvedValue(undefined),
  };
  const manager = new PlexSmartCollectionManager(
    mockPlexApi as unknown as PlexAPI
  );
  return { manager, mockPlexApi };
}

describe('PlexSmartCollectionManager.createFilteredHub', () => {
  it('creates type=4 collection for recently_added_episodes', async () => {
    const { manager, mockPlexApi } = createManager();

    await manager.createFilteredHub(
      'Test Episodes',
      '3',
      'tv',
      'recently_added_episodes'
    );

    const createUrl = mockPlexApi.safePostQuery.mock.calls[0][0] as string;
    expect(createUrl).toContain('type=4');
    expect(createUrl).not.toContain('type=2');
  });

  it('uses show.label!= cross-level filter for recently_added_episodes', async () => {
    const { manager, mockPlexApi } = createManager();

    await manager.createFilteredHub(
      'Test Episodes',
      '3',
      'tv',
      'recently_added_episodes'
    );

    const createUrl = mockPlexApi.safePostQuery.mock.calls[0][0] as string;
    const decodedUri = decodeURIComponent(createUrl);
    expect(decodedUri).toContain('show.label!=trailer-placeholder');
    expect(decodedUri).not.toMatch(/[^.]label!=trailer-placeholder/);
  });

  it('builds an episode-level air-date query with an upper bound for recently_aired_episodes', async () => {
    const { manager, mockPlexApi } = createManager();

    await manager.createFilteredHub(
      'Aired Episodes',
      '3',
      'tv',
      'recently_aired_episodes',
      20,
      ['Some Collection']
    );

    const createUrl = mockPlexApi.safePostQuery.mock.calls[0][0] as string;
    const decodedUri = decodeURIComponent(createUrl);
    expect(createUrl).toContain('type=4');
    expect(decodedUri).toContain('sort=originallyAvailableAt:desc');
    expect(decodedUri).toContain('originallyAvailableAt<<=-0d');
    expect(decodedUri).toContain('show.label!=trailer-placeholder');
    expect(decodedUri).not.toContain('collection!=');
    expect(decodedUri).toContain('limit=20');
  });

  it('rejects recently_aired_episodes on movie libraries', async () => {
    const { manager, mockPlexApi } = createManager();

    const result = await manager.createFilteredHub(
      'Aired Episodes',
      '1',
      'movie',
      'recently_aired_episodes'
    );

    expect(result).toBeNull();
    expect(mockPlexApi.safePostQuery).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        error:
          'recently_aired_episodes subtype is only supported for TV libraries',
      })
    );
  });

  it('creates type=2 collection for recently_released_episodes (shows, not episodes)', async () => {
    const { manager, mockPlexApi } = createManager();

    await manager.createFilteredHub(
      'Test Shows',
      '3',
      'tv',
      'recently_released_episodes'
    );

    const createUrl = mockPlexApi.safePostQuery.mock.calls[0][0] as string;
    expect(createUrl).toContain('type=2');
  });

  it('creates type=1 collection for movie recently_added', async () => {
    const { manager, mockPlexApi } = createManager();

    await manager.createFilteredHub(
      'Test Movies',
      '1',
      'movie',
      'recently_added'
    );

    const createUrl = mockPlexApi.safePostQuery.mock.calls[0][0] as string;
    expect(createUrl).toContain('type=1');
  });

  it('skips collection exclusions for recently_added_episodes', async () => {
    const { manager, mockPlexApi } = createManager();

    await manager.createFilteredHub(
      'Test Episodes',
      '3',
      'tv',
      'recently_added_episodes',
      undefined,
      ['Excluded Collection']
    );

    const createUrl = mockPlexApi.safePostQuery.mock.calls[0][0] as string;
    const decodedUri = decodeURIComponent(createUrl);
    expect(decodedUri).not.toContain('collection!=');
  });

  it('applies collection exclusions for recently_added', async () => {
    const { manager, mockPlexApi } = createManager();

    await manager.createFilteredHub(
      'Test Added',
      '3',
      'tv',
      'recently_added',
      undefined,
      ['Excluded Collection']
    );

    const createUrl = mockPlexApi.safePostQuery.mock.calls[0][0] as string;
    const decodedUri = decodeURIComponent(createUrl);
    expect(decodedUri).toContain('collection!=');
  });

  it('returns null for recently_added_episodes on movie libraries', async () => {
    const { manager } = createManager();

    const result = await manager.createFilteredHub(
      'Test Episodes',
      '1',
      'movie',
      'recently_added_episodes'
    );

    expect(result).toBeNull();
  });
});

describe('PlexSmartCollectionManager.createLabelBasedSmartCollection filterUnwatched', () => {
  it('keeps unwatched=1 in the URI when filterUnwatched is omitted (existing-config default)', async () => {
    const { manager, mockPlexApi } = createManager();

    await manager.createLabelBasedSmartCollection(
      'Family Movies',
      '1',
      'agregarr-unwatched-cfg1',
      'movie'
    );

    const createUrl = mockPlexApi.safePostQuery.mock.calls[0][0] as string;
    const uri = decodeURIComponent(createUrl);
    expect(uri).toContain('unwatched=1');
    expect(uri).toContain('and=1');
    expect(uri).toContain('label=agregarr-unwatched-cfg1');
  });

  it('keeps show.unwatchedLeaves=1 in the URI for TV when filterUnwatched is omitted', async () => {
    const { manager, mockPlexApi } = createManager();

    await manager.createLabelBasedSmartCollection(
      'Family Shows',
      '3',
      'agregarr-unwatched-cfg1',
      'tv'
    );

    const createUrl = mockPlexApi.safePostQuery.mock.calls[0][0] as string;
    const uri = decodeURIComponent(createUrl);
    expect(uri).toContain('show.unwatchedLeaves=1');
    expect(uri).toContain('and=1');
  });

  it('drops unwatched=1 and and=1 from the URI when filterUnwatched is false', async () => {
    const { manager, mockPlexApi } = createManager();

    await manager.createLabelBasedSmartCollection(
      'Family Movies',
      '1',
      'agregarr-unwatched-cfg1',
      'movie',
      undefined,
      undefined,
      undefined,
      false
    );

    const createUrl = mockPlexApi.safePostQuery.mock.calls[0][0] as string;
    const uri = decodeURIComponent(createUrl);
    expect(uri).not.toContain('unwatched=1');
    expect(uri).not.toContain('and=1');
    expect(uri).toContain('label=agregarr-unwatched-cfg1');
  });

  it('drops show.unwatchedLeaves=1 for TV when filterUnwatched is false', async () => {
    const { manager, mockPlexApi } = createManager();

    await manager.createLabelBasedSmartCollection(
      'Family Shows',
      '3',
      'agregarr-unwatched-cfg1',
      'tv',
      undefined,
      undefined,
      undefined,
      false
    );

    const createUrl = mockPlexApi.safePostQuery.mock.calls[0][0] as string;
    const uri = decodeURIComponent(createUrl);
    expect(uri).not.toContain('show.unwatchedLeaves=1');
    expect(uri).not.toContain('and=1');
  });
});

describe('PlexSmartCollectionManager.updateLabelBasedSmartCollectionUri filterUnwatched', () => {
  it('keeps unwatched=1 in the URI when filterUnwatched is omitted (existing-config default)', async () => {
    const { manager, mockPlexApi } = createManager();

    await manager.updateLabelBasedSmartCollectionUri(
      '99999',
      '1',
      'agregarr-unwatched-cfg1',
      'movie'
    );

    const putUrl = mockPlexApi.safePutQuery.mock.calls[0][0] as string;
    const uri = decodeURIComponent(putUrl);
    expect(uri).toContain('unwatched=1');
    expect(uri).toContain('and=1');
  });

  it('drops unwatched=1 and and=1 from the URI when filterUnwatched is false', async () => {
    const { manager, mockPlexApi } = createManager();

    await manager.updateLabelBasedSmartCollectionUri(
      '99999',
      '1',
      'agregarr-unwatched-cfg1',
      'movie',
      undefined,
      undefined,
      false
    );

    const putUrl = mockPlexApi.safePutQuery.mock.calls[0][0] as string;
    const uri = decodeURIComponent(putUrl);
    expect(uri).not.toContain('unwatched=1');
    expect(uri).not.toContain('and=1');
    expect(uri).toContain('label=agregarr-unwatched-cfg1');
  });
});

describe('mapSortOrderToPlexSort', () => {
  it.each([
    ['date_added_desc', 'addedAt:desc'],
    ['date_added_asc', 'addedAt:asc'],
    ['release_date_desc', 'originallyAvailableAt:desc'],
    ['release_date_asc', 'originallyAvailableAt:asc'],
    ['alphabetical_asc', 'titleSort:asc'],
    ['alphabetical_desc', 'titleSort:desc'],
    ['random', 'random'],
  ] as const)('maps %s to %s', (sortOrder, expected) => {
    expect(mapSortOrderToPlexSort(sortOrder)).toBe(expected);
  });

  it.each([
    'default',
    'reverse',
    'imdb_rating_desc',
    'imdb_rating_asc',
    undefined,
  ] as const)('has no Plex equivalent for %s', (sortOrder) => {
    expect(mapSortOrderToPlexSort(sortOrder)).toBeUndefined();
  });
});

describe('PlexSmartCollectionManager.createAttributeCollection sort', () => {
  it('honours the requested date-added sort', async () => {
    const { manager, mockPlexApi } = createManager();

    await manager.createAttributeCollection(
      'Action',
      '4',
      'movie',
      'genre',
      '101085',
      'trailer-placeholder',
      'date_added_desc'
    );

    const createUrl = mockPlexApi.safePostQuery.mock.calls[0][0] as string;
    const decodedUri = decodeURIComponent(createUrl);
    expect(decodedUri).toContain('sort=addedAt:desc');
  });

  it('omits sort param for an unmappable sortOrder', async () => {
    const { manager, mockPlexApi } = createManager();

    await manager.createAttributeCollection(
      'Action',
      '4',
      'movie',
      'genre',
      '101085',
      'trailer-placeholder',
      'reverse'
    );

    const createUrl = mockPlexApi.safePostQuery.mock.calls[0][0] as string;
    const decodedUri = decodeURIComponent(createUrl);
    expect(decodedUri).not.toContain('sort=');
  });

  it('forwards random so Plex shuffles the genre collection', async () => {
    const { manager, mockPlexApi } = createManager();

    await manager.createAttributeCollection(
      'Action',
      '4',
      'movie',
      'genre',
      '101085',
      'trailer-placeholder',
      'random'
    );

    const createUrl = mockPlexApi.safePostQuery.mock.calls[0][0] as string;
    expect(decodeURIComponent(createUrl)).toContain('sort=random');
  });
});

describe('PlexSmartCollectionManager.updateAttributeSmartCollectionUri sort', () => {
  it('honours the requested release-date sort', async () => {
    const { manager, mockPlexApi } = createManager();

    await manager.updateAttributeSmartCollectionUri(
      '99999',
      '4',
      'movie',
      'genre',
      '101085',
      'trailer-placeholder',
      'release_date_asc'
    );

    const putUrl = mockPlexApi.safePutQuery.mock.calls[0][0] as string;
    const decodedUri = decodeURIComponent(putUrl);
    expect(decodedUri).toContain('sort=originallyAvailableAt:asc');
  });
});

describe('PlexSmartCollectionManager.createDirectorCollection sort', () => {
  it('honours the requested alphabetical sort', async () => {
    const { manager, mockPlexApi } = createManager();

    await manager.createDirectorCollection(
      'Nolan Movies',
      '4',
      'movie',
      'Christopher Nolan',
      undefined,
      'alphabetical_asc'
    );

    const createUrl = mockPlexApi.safePostQuery.mock.calls[0][0] as string;
    const decodedUri = decodeURIComponent(createUrl);
    expect(decodedUri).toContain('sort=titleSort:asc');
  });
});

describe('PlexSmartCollectionManager.createActorCollection sort', () => {
  it('honours the requested date-added sort', async () => {
    const { manager, mockPlexApi } = createManager();

    await manager.createActorCollection(
      'Actor Movies',
      '4',
      'movie',
      'Some Actor',
      undefined,
      'date_added_asc'
    );

    const createUrl = mockPlexApi.safePostQuery.mock.calls[0][0] as string;
    const decodedUri = decodeURIComponent(createUrl);
    expect(decodedUri).toContain('sort=addedAt:asc');
  });
});

describe('PlexSmartCollectionManager.updateFilteredHubUri', () => {
  it('uses type=4 in filter URI for recently_added_episodes', async () => {
    const { manager, mockPlexApi } = createManager();

    await manager.updateFilteredHubUri(
      '99999',
      '3',
      'tv',
      'recently_added_episodes'
    );

    const putUrl = mockPlexApi.safePutQuery.mock.calls[0][0] as string;
    const decodedUri = decodeURIComponent(putUrl);
    expect(decodedUri).toContain('type=4');
    expect(decodedUri).toContain('show.label!=trailer-placeholder');
  });

  it('uses the air-date upper bound in the update URI for recently_aired_episodes', async () => {
    const { manager, mockPlexApi } = createManager();

    await manager.updateFilteredHubUri(
      '99999',
      '3',
      'tv',
      'recently_aired_episodes'
    );

    const putUrl = mockPlexApi.safePutQuery.mock.calls[0][0] as string;
    const decodedUri = decodeURIComponent(putUrl);
    expect(decodedUri).toContain('type=4');
    expect(decodedUri).toContain('sort=originallyAvailableAt:desc');
    expect(decodedUri).toContain('originallyAvailableAt<<=-0d');
    expect(decodedUri).toContain('show.label!=trailer-placeholder');
  });

  it('uses type=2 in filter URI for recently_added on TV', async () => {
    const { manager, mockPlexApi } = createManager();

    await manager.updateFilteredHubUri('99999', '3', 'tv', 'recently_added');

    const putUrl = mockPlexApi.safePutQuery.mock.calls[0][0] as string;
    const decodedUri = decodeURIComponent(putUrl);
    expect(decodedUri).toContain('type=2');
  });
});

import type PlexAPI from '@server/api/plexapi';
import type { PlexCollection } from '@server/lib/collections/core/types';
import type { CollectionConfig } from '@server/lib/settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/entity/PosterTemplate', () => ({
  PosterTemplate: class {},
}));
vi.mock('@server/entity/CollectionMetadata', () => ({
  CollectionMetadata: class {},
}));
vi.mock('@server/entity/User', () => ({ User: class {} }));
vi.mock('@server/api/imdbRatings', () => ({ default: class {} }));
vi.mock('@server/lib/cache', () => ({ default: { getCache: vi.fn() } }));
vi.mock('@server/lib/posterStorage', () => ({ generatePoster: vi.fn() }));
vi.mock('@server/lib/collections/services/ServiceUserManager', () => ({
  serviceUserManager: {},
}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    plex: { collectionConfigs: [] },
    main: {},
  }),
  getTmdbLanguage: () => 'en',
}));

vi.mock('@server/lib/collections/utils/TemplateEngine', () => ({
  templateEngine: {
    processTemplate: (template: string, context: { actor?: string }) => {
      return template.replace(/{actor}/g, context.actor ?? '');
    },
  },
  TemplateEngine: class {},
}));

vi.mock('@server/lib/collections/core/CollectionUtilities', () => ({
  extractTmdbIdFromGuids: vi.fn(),
  extractTvdbIdFromGuids: vi.fn(),
  getAdminUser: vi.fn(),
  getCollectionMediaType: vi.fn(),
  hasAgregarrLabel: vi.fn(),
}));

vi.mock('@server/api/plexapi', () => ({ default: class {} }));
vi.mock('@server/api/themoviedb', () => ({ default: class {} }));

import { PlexLibraryCollectionSync, posterSourceOrder } from './plexlibrary';

describe('PlexLibraryCollectionSync person cleanup', () => {
  let sync: PlexLibraryCollectionSync;

  beforeEach(() => {
    sync = new PlexLibraryCollectionSync();
  });

  it('retains qualifying collections when template wraps person name', async () => {
    const deleteCollection = vi.fn();
    const plexClient = {
      getLibraryActors: vi.fn().mockResolvedValue([
        { name: 'Tom Hanks', count: 10 },
        { name: 'Meryl Streep', count: 8 },
      ]),
      createActorCollection: vi.fn().mockResolvedValue('rk-new'),
      deleteCollection,
      getCollectionLabels: vi.fn().mockResolvedValue([]),
      addCollectionLabel: vi.fn(),
      updateCollection: vi.fn(),
    } as unknown as PlexAPI;

    const config = {
      id: 'cfg-1',
      name: 'Starring {actor}',
      template: 'custom',
      customMovieTemplate: 'Starring {actor}',
      subtype: 'actors',
      libraryId: '1',
      personMinimumItems: 5,
      autoPoster: false,
    } as unknown as CollectionConfig;

    const allCollections = [
      {
        title: 'Starring Tom Hanks',
        ratingKey: 'rk-1',
        libraryKey: '1',
        labels: [{ tag: 'AgregarrAutoActor-cfg-1-1234' }],
      },
      {
        title: 'Starring Meryl Streep',
        ratingKey: 'rk-2',
        libraryKey: '1',
        labels: [{ tag: 'AgregarrAutoActor-cfg-1-5678' }],
      },
    ] as unknown as PlexCollection[];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sync as any).processConfiguration(
      config,
      plexClient,
      allCollections,
      new Set()
    );

    expect(deleteCollection).not.toHaveBeenCalled();
  });
});

describe('posterSourceOrder', () => {
  const items = [{ ratingKey: '30' }, { ratingKey: '4' }, { ratingKey: '200' }];

  it('gives random collections a stable order so the poster hash holds', () => {
    expect(posterSourceOrder(items, 'random').map((i) => i.ratingKey)).toEqual([
      '4',
      '30',
      '200',
    ]);
  });

  it('keeps Plex order for every other sort', () => {
    expect(posterSourceOrder(items, 'date_added_desc')).toBe(items);
  });
});

describe('separator poster', () => {
  const makeSync = () => {
    const sync = new PlexLibraryCollectionSync();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = sync as any;
    s.getSeparatorLabel = () => 'AgregarrSeparator-test';
    s.getSeparatorTitle = () => 'Genre Collections';
    s.buildSeparatorSortTitle = () => 'Genre Collections';
    s.resolveSeparatorTemplateId = vi.fn().mockResolvedValue(7);
    s.updateCollectionMetadata = vi.fn().mockResolvedValue(undefined);
    s.generateAutoPoster = vi.fn().mockResolvedValue(undefined);
    const plexClient = {
      createEmptyCollection: vi.fn().mockResolvedValue('rk-sep'),
      getCollectionByName: vi.fn().mockResolvedValue(null),
      updateCollectionMode: vi.fn(),
      updateCollectionSortTitle: vi.fn(),
    } as unknown as PlexAPI;
    return { s, plexClient };
  };

  const baseConfig = {
    id: 'sep-1',
    subtype: 'separator',
    libraryId: '3',
    visibilityConfig: {},
  };

  it('uploads the custom poster instead of generating when auto-generate is off', async () => {
    const { s, plexClient } = makeSync();
    await s.syncSeparatorCollection(
      { ...baseConfig, autoPoster: false, customPoster: { '3': 'sep.png' } },
      plexClient,
      [],
      'movie'
    );
    expect(s.generateAutoPoster).not.toHaveBeenCalled();
    expect(s.updateCollectionMetadata).toHaveBeenCalledWith(
      plexClient,
      'rk-sep',
      expect.objectContaining({ customPoster: { '3': 'sep.png' } })
    );
  });

  it('still generates the template poster when auto-generate is on', async () => {
    const { s, plexClient } = makeSync();
    await s.syncSeparatorCollection(
      { ...baseConfig, autoPoster: true, customPoster: { '3': 'sep.png' } },
      plexClient,
      [],
      'movie'
    );
    expect(s.generateAutoPoster).toHaveBeenCalledTimes(1);
  });

  it('generates when auto-generate is off but no upload exists for the library', async () => {
    const { s, plexClient } = makeSync();
    await s.syncSeparatorCollection(
      { ...baseConfig, autoPoster: false, customPoster: { '9': 'x.png' } },
      plexClient,
      [],
      'movie'
    );
    expect(s.generateAutoPoster).toHaveBeenCalledTimes(1);
  });
});

describe('essentials selection mode default', () => {
  it('creates every value when selectionMode is missing', async () => {
    const sync = new PlexLibraryCollectionSync();
    const plexClient = {
      getLibraryAttributes: vi.fn().mockResolvedValue([
        { key: 'g1', title: 'Alpha' },
        { key: 'g2', title: 'Beta' },
      ]),
      createAttributeCollection: vi.fn().mockResolvedValue('rk-new'),
      addLabelToCollection: vi.fn(),
    } as unknown as PlexAPI;
    const config = {
      id: 'ess-1',
      subtype: 'genre',
      libraryId: '3',
      template: '{value}',
      autoPoster: false,
    } as unknown as CollectionConfig;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = sync as any;
    s.cleanupSeparatorCollection = vi.fn();
    s.updateCollectionMetadata = vi.fn();
    await s.processEssentialsConfiguration(
      config,
      plexClient,
      [],
      'movie',
      'genre'
    );

    expect(plexClient.createAttributeCollection).toHaveBeenCalledTimes(2);
  });

  it('treats a missing selectionMode with includeValues as include', async () => {
    const sync = new PlexLibraryCollectionSync();
    const plexClient = {
      getLibraryAttributes: vi.fn().mockResolvedValue([
        { key: 'g1', title: 'Alpha' },
        { key: 'g2', title: 'Beta' },
      ]),
      createAttributeCollection: vi.fn().mockResolvedValue('rk-new'),
      addLabelToCollection: vi.fn(),
    } as unknown as PlexAPI;
    const config = {
      id: 'ess-2',
      subtype: 'genre',
      libraryId: '3',
      template: '{value}',
      autoPoster: false,
      includeValues: ['g2'],
    } as unknown as CollectionConfig;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = sync as any;
    s.cleanupSeparatorCollection = vi.fn();
    s.updateCollectionMetadata = vi.fn();
    await s.processEssentialsConfiguration(
      config,
      plexClient,
      [],
      'movie',
      'genre'
    );

    expect(plexClient.createAttributeCollection).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(plexClient.createAttributeCollection).mock.calls[0][4]
    ).toBe('g2');
  });
});

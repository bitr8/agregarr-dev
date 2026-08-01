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

import { PlexLibraryCollectionSync } from './plexlibrary';

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

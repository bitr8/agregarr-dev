import type PlexAPI from '@server/api/plexapi';
import { BaseCollectionSync } from '@server/lib/collections/core/BaseCollectionSync';
import type {
  CollectionItem,
  TmdbFranchiseSourceData,
} from '@server/lib/collections/core/types';
import type { CollectionConfig } from '@server/lib/settings';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/entity/CollectionMetadata', () => ({
  CollectionMetadata: class {},
}));
vi.mock('@server/entity/CollectionMissingItems', () => ({
  CollectionMissingItems: class {},
}));
vi.mock('@server/entity/PosterTemplate', () => ({ PosterTemplate: class {} }));
vi.mock('@server/entity/User', () => ({ User: class {} }));
vi.mock('@server/api/imdbRatings', () => ({ default: class {} }));
vi.mock('@server/lib/cache', () => ({
  default: { getCache: vi.fn(() => ({ data: {} })) },
}));
vi.mock('@server/lib/posterStorage', () => ({ generatePoster: vi.fn() }));
vi.mock('@server/lib/collections/services/ServiceUserManager', () => ({
  serviceUserManager: {},
}));
vi.mock('@server/lib/collections/utils/TemplateEngine', () => ({
  templateEngine: {
    createFranchiseContext: vi.fn((franchiseData: TmdbFranchiseSourceData) => ({
      franchiseName: franchiseData.franchiseName,
    })),
    processTemplate: vi.fn(
      async (_template: string, context: { franchiseName: string }) =>
        context.franchiseName
    ),
  },
}));
vi.mock('@server/lib/collections/sources/overseerr', () => ({
  overseerrCollectionService: {},
}));
vi.mock('@server/lib/placeholders/services/PlaceholderCleanup', () => ({
  handlePlaceholderCleanup: vi.fn(async () => undefined),
}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    globalExclusions: { movies: [], tv: [], tvdb: [] },
    plex: {
      collectionConfigs: [],
      libraries: [{ key: 'L1', name: 'Movies', type: 'movie' }],
    },
    save: vi.fn(),
  }),
  getTmdbLanguage: vi.fn(async () => 'en'),
}));

import { LetterboxdCollectionSync } from './letterboxd';
import { OverseerrCollectionSync } from './overseerrSync';
import { TautulliCollectionSync } from './tautulli';
import { TmdbCollectionSync } from './tmdb';

const item = (ratingKey: string, tmdbId?: number): CollectionItem => ({
  ratingKey,
  title: `Item ${ratingKey}`,
  type: 'movie',
  tmdbId,
});

const LABELLED = 'k2';

const makePlex = (labelled: string[] = [LABELLED]) => {
  const updateCollectionContents = vi.fn(async () => ({
    added: 0,
    removed: 1,
    removedKeys: [LABELLED],
    reordered: false,
    errors: [],
  }));
  const getRatingKeysWithLabel = vi.fn(
    async (_library: string, label: string) =>
      new Set(label.toLowerCase() === 'placeholder' ? labelled : [])
  );
  return {
    plex: {
      getRatingKeysWithLabel,
      updateCollectionContents,
      addLabelToItem: vi.fn(async () => undefined),
    } as unknown as PlexAPI,
    updateCollectionContents,
  };
};

const cfg = (extra: Partial<CollectionConfig> = {}): CollectionConfig =>
  ({
    id: 'cfg-1',
    name: 'Test',
    type: 'imdb',
    subtype: 'popular',
    libraryId: 'L1',
    isActive: true,
    excludeLabels: ['Placeholder'],
    ...extra,
  } as CollectionConfig);

const keysOf = (call: unknown[]) =>
  (call[0] as CollectionItem[]).map((i) => i.ratingKey);

class BaseSync extends BaseCollectionSync<'imdb'> {
  constructor() {
    super('imdb');
  }
  protected async validateConfiguration(): Promise<void> {
    return;
  }
  protected async processConfiguration(): Promise<never> {
    throw new Error('unused');
  }
  protected createTemplateContext(): never {
    throw new Error('unused');
  }
  public async fetchSourceData(): Promise<never> {
    throw new Error('unused');
  }
  public mapSourceDataToItems(): never {
    throw new Error('unused');
  }
  protected async createCollection(): Promise<never> {
    throw new Error('unused');
  }
}

describe('label exclusion on every write path', () => {
  it('standard sync drops labelled items before writing', async () => {
    const sync = new BaseSync();
    const write = vi
      .spyOn(sync, 'createOrUpdateCollectionStandardized')
      .mockResolvedValue({ created: 0, updated: 1 } as never);
    vi.spyOn(
      sync as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>,
      'generateCollectionNameWithCustom'
    ).mockResolvedValue('Test' as never);
    const { plex } = makePlex();

    await (sync as any).processSingleMediaType(
      [item('k1'), item(LABELLED), item('k3')],
      cfg(),
      'movie',
      plex,
      []
    );

    expect(keysOf(write.mock.calls[0])).toEqual(['k1', 'k3']);
  });

  it('standard sync empties the existing collection when labels exclude everything, without writing', async () => {
    const sync = new BaseSync();
    const write = vi.spyOn(sync, 'createOrUpdateCollectionStandardized');
    const { plex, updateCollectionContents } = makePlex();

    const result = await (sync as any).processSingleMediaType(
      [item(LABELLED)],
      cfg({ collectionRatingKey: 'c9' }),
      'movie',
      plex,
      []
    );

    expect(result.itemCount).toBe(0);
    expect(write).not.toHaveBeenCalled();
    expect(updateCollectionContents).toHaveBeenCalledWith('c9', [], 'Test');
  });

  it('standard sync leaves the collection alone when the list was empty before labels', async () => {
    const sync = new BaseSync();
    const { plex, updateCollectionContents } = makePlex();

    await (sync as any).processSingleMediaType(
      [],
      cfg({ collectionRatingKey: 'c9' }),
      'movie',
      plex,
      []
    );

    expect(updateCollectionContents).not.toHaveBeenCalled();
  });

  it('tautulli createCollection drops labelled items', async () => {
    const sync = new TautulliCollectionSync();
    const write = vi
      .spyOn(sync, 'createOrUpdateCollectionStandardized')
      .mockResolvedValue({ created: 1, updated: 0 } as never);
    const { plex } = makePlex();

    await (sync as any).createCollection(
      [item('k1'), item(LABELLED)],
      'movie',
      'Test',
      plex,
      [],
      cfg({ type: 'tautulli' })
    );

    expect(keysOf(write.mock.calls[0])).toEqual(['k1']);
  });

  it('overseerr createCollection drops labelled items on the regular and smart paths', async () => {
    const sync = new OverseerrCollectionSync();
    const write = vi
      .spyOn(sync, 'createOrUpdateCollectionStandardized')
      .mockResolvedValue({ created: 1, updated: 0 } as never);
    const smart = vi
      .spyOn(
        sync as unknown as Record<
          string,
          (...a: unknown[]) => Promise<unknown>
        >,
        'handleUserSmartCollectionCreation'
      )
      .mockResolvedValue({ created: 1, updated: 0 } as never);
    vi.spyOn(
      sync as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>,
      'generateAutoPoster'
    ).mockResolvedValue(undefined as never);
    const { plex } = makePlex();
    const user = { id: 3, plexId: '3', username: 'u' };

    await (sync as any).createCollection(
      [item('k1'), item(LABELLED)],
      'movie',
      'Test',
      plex,
      [],
      cfg({ type: 'overseerr', subtype: 'users' }),
      undefined,
      user
    );
    await (sync as any).createCollection(
      [item('k1'), item(LABELLED)],
      'movie',
      'Test',
      plex,
      [],
      cfg({ type: 'overseerr', subtype: 'users', showUnwatchedOnly: true }),
      undefined,
      user
    );

    expect(keysOf(write.mock.calls[0])).toEqual(['k1']);
    expect(
      (smart.mock.calls[0][1] as CollectionItem[]).map((i) => i.ratingKey)
    ).toEqual(['k1']);
  });

  it('letterboxd drops labelled items including placeholders before writing', async () => {
    const sync = new LetterboxdCollectionSync();
    const s = sync as any;
    vi.spyOn(s, 'fetchSourceData').mockResolvedValue([{}]);
    vi.spyOn(s, 'mapSourceDataToItems').mockResolvedValue({});
    vi.spyOn(s, 'applyFilteringToMappedItems').mockResolvedValue({
      items: [item('k1')],
      missingItems: [],
    });
    vi.spyOn(s, 'tagExistingItemsInArr').mockResolvedValue(undefined);
    vi.spyOn(s, 'handlePlaceholdersAndMissingItems').mockResolvedValue([
      item(LABELLED),
    ]);
    vi.spyOn(s, 'generateCollectionNameWithCustom').mockResolvedValue('Test');
    const write = vi
      .spyOn(sync, 'createOrUpdateCollectionStandardized')
      .mockResolvedValue({ created: 1, updated: 0 } as never);
    const { plex } = makePlex();

    await s.processConfiguration(
      cfg({ type: 'letterboxd', subtype: 'custom' }),
      plex,
      [],
      undefined,
      undefined,
      {}
    );

    expect(keysOf(write.mock.calls[0])).toEqual(['k1']);
  });

  it('tmdb franchise drops labelled items before writing', async () => {
    const sync = new TmdbCollectionSync();
    const s = sync as any;
    const data: TmdbFranchiseSourceData = {
      franchiseId: 1,
      franchiseName: 'Franchise 1',
      movies: [10, 11, 12].map((tmdbId) => ({ tmdbId, title: `M${tmdbId}` })),
    };
    vi.spyOn(s, 'getLibraryMovies').mockResolvedValue(
      [10, 11, 12].map((tmdbId) => ({
        ratingKey: `k${tmdbId}`,
        title: `M${tmdbId}`,
        type: 'movie',
        tmdbId,
      }))
    );
    vi.spyOn(s, 'discoverFranchises').mockResolvedValue({
      franchiseMap: new Map([[1, data]]),
      failedCount: 0,
    });
    vi.spyOn(s, 'findPlexItemsForFranchise').mockResolvedValue(
      [10, 11, 12].map((tmdbId) => ({
        ratingKey: `k${tmdbId}`,
        title: `M${tmdbId}`,
        type: 'movie',
        tmdbId,
      }))
    );
    vi.spyOn(s, 'processMissingItems').mockResolvedValue([]);
    const write = vi
      .spyOn(sync, 'createOrUpdateCollectionStandardized')
      .mockResolvedValue({ created: 1, updated: 0 } as never);
    const { plex } = makePlex(['k11']);

    await s.processFranchiseCollections(
      cfg({ type: 'tmdb', subtype: 'auto_franchise' }),
      plex,
      [],
      undefined,
      { L1: [] }
    );

    expect(keysOf(write.mock.calls[0])).toEqual(['k10', 'k12']);
  });
});

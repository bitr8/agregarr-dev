import type PlexAPI from '@server/api/plexapi';
import type { CollectionConfig } from '@server/lib/settings';
import { describe, expect, it, vi, type MockInstance } from 'vitest';

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
vi.mock('@server/lib/cache', () => ({ default: { getCache: vi.fn() } }));
vi.mock('@server/lib/posterStorage', () => ({ generatePoster: vi.fn() }));
vi.mock('@server/lib/collections/services/ServiceUserManager', () => ({
  serviceUserManager: {},
}));
vi.mock('@server/lib/collections/utils/TemplateEngine', () => ({
  templateEngine: { processTemplate: (t: string) => t },
}));
vi.mock('@server/lib/collections/plex/PlexSmartCollectionManager', () => ({
  default: class {
    updateFilteredHubUri = vi.fn(async () => undefined);
    createFilteredHub = vi.fn(async () => 'NEW');
  },
}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const settings = {
  plex: {
    collectionConfigs: [] as CollectionConfig[],
    libraries: [{ key: '4', name: 'Movies', type: 'movie' }],
  },
  save: vi.fn(),
};
vi.mock('@server/lib/settings', () => ({ getSettings: () => settings }));

import { FilteredHubCollectionSync } from './recentlyadded';

const metadataCall = async (
  overrides: Partial<CollectionConfig>,
  existingLabels: string[] = [],
  laterCollections: { ratingKey: string; labels: string[] }[] = []
) => {
  const sync = new FilteredHubCollectionSync();
  const metadata = (
    vi.spyOn(
      sync as never,
      'updateCollectionMetadata'
    ) as unknown as MockInstance
  ).mockResolvedValue({} as never);
  const cfg = {
    id: '10',
    name: 'Hub',
    template: 'Hub',
    type: 'filtered_hub',
    subtype: 'recently_added',
    libraryId: '4',
    mediaType: 'movie',
    isActive: true,
    autoPoster: false,
    ...overrides,
  } as CollectionConfig;
  settings.plex.collectionConfigs = [cfg];

  await (
    sync as unknown as {
      processConfiguration: (...a: unknown[]) => Promise<unknown>;
    }
  ).processConfiguration(cfg, {} as PlexAPI, [
    { ratingKey: '500', title: 'Hub', libraryKey: '4', labels: existingLabels },
    ...laterCollections.map((c) => ({
      ...c,
      title: 'Hub',
      libraryKey: '4',
    })),
  ]);

  const [, ratingKey, options] = metadata.mock.calls[0] as [
    unknown,
    string,
    { customLabel: string }
  ];
  return { ratingKey, label: options.customLabel };
};

const labelsUsed = async (
  overrides: Partial<CollectionConfig>,
  existingLabels: string[] = []
) => (await metadataCall(overrides, existingLabels)).label;

describe('filtered hub label', () => {
  const stale = (extra: Partial<CollectionConfig> = {}) => ({
    collectionRatingKey: '999',
    ...extra,
  });

  it('carries the target-user label so the sharing filter can hide it', async () => {
    expect(
      await labelsUsed({ targetUserId: '1001', collectionRatingKey: '500' })
    ).toBe('AgregarrTargetUser_10_1001');
  });

  it('keeps the filtered-hub identity label without a target user', async () => {
    expect(await labelsUsed({ collectionRatingKey: '500' })).toBe(
      'Agregarr-filtered_hub-10'
    );
  });

  it('re-adopts a hub that still carries the old identity label once a target user is set', async () => {
    const call = await metadataCall(stale({ targetUserId: '1001' }), [
      'Agregarr-filtered_hub-10',
    ]);
    expect(call).toEqual({
      ratingKey: '500',
      label: 'AgregarrTargetUser_10_1001',
    });
  });

  it('re-adopts a hub that carries the target-user label after the user is cleared', async () => {
    const call = await metadataCall(stale(), ['AgregarrTargetUser_10_1001']);
    expect(call).toEqual({
      ratingKey: '500',
      label: 'Agregarr-filtered_hub-10',
    });
  });

  it('prefers the collection with the current label over an older leftover', async () => {
    const call = await metadataCall(
      stale({ targetUserId: '1002' }),
      ['AgregarrTargetUser_10_1001'],
      [{ ratingKey: '600', labels: ['AgregarrTargetUser_10_1002'] }]
    );
    expect(call).toEqual({
      ratingKey: '600',
      label: 'AgregarrTargetUser_10_1002',
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  libraries: [] as { key: string; type: string }[],
  findOne: vi.fn(),
  getChildrenMetadata: vi.fn(),
  getAdminUser: vi.fn(async () => ({ plexToken: 'test-token' })),
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({ plex: { libraries: mocks.libraries } }),
}));

vi.mock('@server/datasource', () => ({ getRepository: () => mocks }));
vi.mock('@server/entity/OverlayLibraryConfig', () => ({
  OverlayLibraryConfig: class {},
}));
vi.mock('@server/entity/OverlayTemplate', () => ({
  OverlayTemplate: class {},
}));
vi.mock('@server/api/plexapi', () => ({
  default: class {
    getChildrenMetadata = mocks.getChildrenMetadata;
  },
}));
vi.mock('@server/lib/collections/core/CollectionUtilities', () => ({
  getAdminUser: mocks.getAdminUser,
}));
vi.mock('./OverlayContextBuilder', () => ({}));
vi.mock('./OverlayTemplateRenderer', () => ({}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import logger from '@server/logger';
import { overlayLibraryService } from './OverlayLibraryService';

describe('Posterizarr overlay scope at the batch-write boundary', () => {
  const callback = {
    ratingKey: 'show-1',
    mediaType: 'show' as const,
    seasonNumber: 2,
    episodeNumber: 3,
  };
  const apply = vi
    .spyOn(overlayLibraryService, 'applyOverlaysToCollectionItems')
    .mockResolvedValue();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.libraries = [];
    mocks.findOne.mockResolvedValue({
      mediaType: 'show',
      enabledOverlays: [{ templateId: 1, enabled: true }],
      fullSyncTargets: ['main', 'season', 'episode'],
    });
    mocks.getChildrenMetadata.mockImplementation(async (key: string) =>
      key === 'show-1'
        ? [{ type: 'season', index: 2, ratingKey: 'season-2' }]
        : [{ type: 'episode', index: 3, ratingKey: 'episode-3' }]
    );
  });

  it('keeps default callbacks main-only even when full sync includes children', async () => {
    await overlayLibraryService.applyPosterizarrTriggeredOverlays(
      callback,
      '2'
    );
    expect(apply).toHaveBeenCalledWith(
      [{ ratingKey: 'show-1', target: 'main' }],
      '2'
    );
    expect(mocks.getChildrenMetadata).not.toHaveBeenCalled();
  });

  it.each([
    ['season'],
    ['episode'],
    ['main', 'season', 'episode'],
    ['episode', 'main'],
  ])(
    'only hands selected quick-sync targets %j to the writer',
    async (...targets) => {
      mocks.findOne.mockResolvedValue({
        mediaType: 'show',
        enabledOverlays: [{ templateId: 1, enabled: true }],
        fullSyncTargets: ['main'],
        quickSyncTargets: targets,
      });
      await overlayLibraryService.applyPosterizarrTriggeredOverlays(
        callback,
        '2'
      );
      expect(apply).toHaveBeenCalledOnce();
      expect(apply.mock.calls[0][0]).toHaveLength(targets.length);
      expect(apply.mock.calls[0][0]).toEqual(
        expect.arrayContaining(
          targets.map((target) =>
            expect.objectContaining({
              target,
              ratingKey:
                target === 'main'
                  ? 'show-1'
                  : target === 'season'
                  ? 'season-2'
                  : 'episode-3',
            })
          )
        )
      );
      expect(mocks.getChildrenMetadata).toHaveBeenCalledTimes(
        targets.includes('episode') ? 2 : 1
      );
    }
  );

  it.each([
    null,
    {
      mediaType: 'show',
      quickSyncTargets: [],
      enabledOverlays: [{ enabled: true }],
    },
    {
      mediaType: 'show',
      quickSyncTargets: ['episode'],
      enabledOverlays: [{ enabled: false }],
    },
  ])(
    'does no Plex work when the library or its scope is disabled',
    async (config) => {
      mocks.findOne.mockResolvedValue(config);
      await overlayLibraryService.applyPosterizarrTriggeredOverlays(
        callback,
        '2'
      );
      expect(apply).not.toHaveBeenCalled();
      expect(mocks.getChildrenMetadata).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining(
          config?.quickSyncTargets.length === 0
            ? 'scope is empty'
            : 'no enabled library overlays'
        ),
        expect.objectContaining({ libraryId: '2' })
      );
    }
  );

  it('logs when the callback cannot select an item in its scope', async () => {
    mocks.findOne.mockResolvedValue({
      mediaType: 'show',
      quickSyncTargets: ['episode'],
      enabledOverlays: [{ enabled: true }],
    });
    await overlayLibraryService.applyPosterizarrTriggeredOverlays(
      { ratingKey: 'show-1' },
      '2'
    );
    expect(apply).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('no items match Quick sync scope'),
      expect.objectContaining({
        libraryId: '2',
        ratingKey: 'show-1',
        targets: ['episode'],
      })
    );
  });

  it.each([
    ['movie', 'show', ['season-2']],
    ['show', 'movie', []],
  ] as const)(
    'ignores stored type %s in favor of Plex library type %s',
    async (storedType, plexType, expectedKeys) => {
      mocks.libraries = [{ key: '2', type: plexType }];
      mocks.findOne.mockResolvedValue({
        mediaType: storedType,
        quickSyncTargets: ['season'],
        enabledOverlays: [{ enabled: true }],
      });
      await overlayLibraryService.applyPosterizarrTriggeredOverlays(
        callback,
        '2'
      );
      expect(
        apply.mock.calls.flatMap(([items]) =>
          items.map((item) =>
            typeof item === 'string' ? item : item.ratingKey
          )
        )
      ).toEqual(expectedKeys);
    }
  );

  it('does not acquire child targets for a movie library', async () => {
    mocks.findOne.mockResolvedValue({
      mediaType: 'movie',
      quickSyncTargets: ['main', 'season', 'episode'],
      enabledOverlays: [{ enabled: true }],
    });
    await overlayLibraryService.applyPosterizarrTriggeredOverlays(
      callback,
      '1'
    );
    expect(apply).toHaveBeenCalledWith(
      [{ ratingKey: 'show-1', target: 'main' }],
      '1'
    );
    expect(mocks.getChildrenMetadata).not.toHaveBeenCalled();
  });
});

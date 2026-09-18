import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findOne: vi.fn(),
  getChildrenMetadata: vi.fn(),
  getAdminUser: vi.fn(async () => ({ plexToken: 'test-token' })),
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

  it.each([['season'], ['episode'], ['main', 'season', 'episode']])(
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
      expect(apply.mock.calls[0][0]).toEqual(
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

import { beforeEach, describe, expect, it, vi } from 'vitest';

const repository = vi.hoisted(() => ({
  findOne: vi.fn(),
  save: vi.fn(async (value) => value),
}));

vi.mock('@server/datasource', () => ({
  getRepository: () => repository,
}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn() },
}));

import metadataTrackingService from './MetadataTrackingService';

describe('metadata tracking reset ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retains clean base data while clearing prior overlay ownership', async () => {
    repository.findOne.mockResolvedValue({
      plexItemRatingKey: 'episode-1',
      libraryKey: '2',
      itemType: 'episode',
      lastOverlayInputHash: 'hash',
      lastPosterUploadUrl: '/uploaded',
      lastOverlayAppliedAt: new Date(),
      ourOverlayPosterUrl: '/uploaded',
    });

    await metadataTrackingService.recordBasePosterReset(
      'episode-1',
      '2',
      {
        basePosterSource: 'plex',
        originalPlexPosterUrl: '/clean',
        basePosterFilename: 'episode-1.jpg',
      },
      'episode'
    );

    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        lastOverlayInputHash: null,
        lastPosterUploadUrl: null,
        lastOverlayAppliedAt: null,
        ourOverlayPosterUrl: null,
        basePosterSource: 'plex',
        originalPlexPosterUrl: '/clean',
        basePosterFilename: 'episode-1.jpg',
      })
    );
  });
});

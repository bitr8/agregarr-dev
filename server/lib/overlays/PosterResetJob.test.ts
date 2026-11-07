import type { PlexMetadata } from '@server/api/plexapi';
import { MediaItemMetadata } from '@server/entity/MediaItemMetadata';
import sharp from 'sharp';
import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  repository: undefined as Repository<MediaItemMetadata> | undefined,
  getMetadata: vi.fn(),
  getMetadataBatch: vi.fn(),
  upload: vi.fn(),
  base: vi.fn(),
}));
vi.mock('@server/datasource', () => ({
  getRepository: () => mocks.repository,
}));
vi.mock('@server/lib/overlayApplication', () => ({
  default: { running: false },
}));
vi.mock('@server/lib/collections/core/CollectionUtilities', () => ({
  getAdminUser: async () => ({ plexToken: 'test-token' }),
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({ overlays: {} }),
}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('fs/promises', () => ({
  default: { writeFile: vi.fn(), unlink: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('./PlexBasePosterManager', () => ({
  resolveBasePosterSource: () => 'plex',
  resolveBasePosterSourceWithTrail: () => ({ source: 'plex', tried: [] }),
  plexBasePosterManager: { getBasePosterForOverlay: mocks.base },
}));
vi.mock('@server/api/plexapi', () => ({
  default: class {
    getLibraries = async () => [{ key: '2', title: 'Shows', type: 'show' }];
    getLibraryContents = async () => ({ items: [], totalSize: 0 });
    getMetadata = mocks.getMetadata;
    getMetadataBatch = mocks.getMetadataBatch;
    uploadPosterFromFile = mocks.upload;
    removeLabelFromItem = vi.fn();
  },
}));

import metadataTrackingService from '@server/lib/metadata/MetadataTrackingService';
import logger from '@server/logger';
import { posterResetJob } from './PosterResetJob';

describe('poster reset child artwork', () => {
  let database: DataSource;
  const child = (ratingKey: string) =>
    ({
      ratingKey,
      title: 'Artwork',
      type: ratingKey === 'season' ? 'season' : 'episode',
    } as PlexMetadata);

  beforeEach(async () => {
    vi.clearAllMocks();
    database = await new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [MediaItemMetadata],
      synchronize: true,
    }).initialize();
    mocks.repository = database.getRepository(MediaItemMetadata);
    mocks.getMetadata.mockImplementation(async (key: string) => child(key));
    mocks.getMetadataBatch.mockImplementation(
      async (keys: string[]) => new Map(keys.map((key) => [key, child(key)]))
    );
    mocks.base.mockResolvedValue({
      posterBuffer: await sharp({
        create: { width: 16, height: 9, channels: 3, background: '#334455' },
      })
        .png()
        .toBuffer(),
      sourceUrl: '/clean',
      filename: 'clean.jpg',
    });
  });

  afterEach(async () => {
    await database?.destroy();
  });

  const seed = async (rows: Partial<MediaItemMetadata>[]) => {
    await database.getRepository(MediaItemMetadata).save(
      rows.map(
        (row) =>
          new MediaItemMetadata({
            libraryKey: '2',
            itemType: 'episode',
            ourOverlayPosterUrl: '/overlay',
            ...row,
          })
      )
    );
  };

  it('queries only owned child rows and does not re-upload them on a second reset', async () => {
    await seed([
      { plexItemRatingKey: 'episode' },
      { plexItemRatingKey: 'season', itemType: 'season' },
      { plexItemRatingKey: 'show', itemType: 'show' },
      { plexItemRatingKey: 'unowned', ourOverlayPosterUrl: undefined },
      { plexItemRatingKey: 'foreign', libraryKey: '3' },
    ]);
    expect(
      (await metadataTrackingService.getOverlaidChildMetadata('2'))
        .map((row) => row.plexItemRatingKey)
        .sort()
    ).toEqual(['episode', 'season']);
    await posterResetJob.resetLibraryPosters('2');
    expect(mocks.upload.mock.calls.map(([key]) => key).sort()).toEqual([
      'episode',
      'season',
    ]);
    expect(posterResetJob.status).toMatchObject({
      total: 2,
      current: 2,
      failed: 0,
    });
    expect(await metadataTrackingService.getOverlaidChildMetadata('2')).toEqual(
      []
    );
    expect(await database.getRepository(MediaItemMetadata).count()).toBe(5);
    mocks.upload.mockClear();
    mocks.getMetadataBatch.mockClear();
    await posterResetJob.resetLibraryPosters('2');
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.getMetadataBatch).not.toHaveBeenCalled();
  });

  it('shows the child total and stops after an in-flight batch when cancelled', async () => {
    await seed(
      Array.from({ length: 101 }, (_, index) => ({
        plexItemRatingKey: String(index),
      }))
    );
    mocks.getMetadataBatch.mockImplementationOnce(async () => {
      expect(posterResetJob.status).toMatchObject({
        running: true,
        total: 101,
        current: 0,
      });
      posterResetJob.cancel();
      return new Map();
    });
    await posterResetJob.resetLibraryPosters('2');
    expect(mocks.getMetadataBatch).toHaveBeenCalledOnce();
    expect(mocks.getMetadataBatch.mock.calls[0][0]).toHaveLength(50);
    expect(mocks.getMetadata).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(posterResetJob.status).toMatchObject({
      running: false,
      cancelled: true,
    });
    expect(logger.info).toHaveBeenCalledWith(
      'Poster reset cancelled during child enumeration',
      expect.objectContaining({ label: 'PosterReset', libraryId: '2' })
    );
  });

  it('checks cancellation between individual fallbacks for missing batch rows', async () => {
    await seed([{ plexItemRatingKey: '1' }, { plexItemRatingKey: '2' }]);
    mocks.getMetadataBatch.mockResolvedValueOnce(new Map());
    mocks.getMetadata.mockImplementationOnce(async () => {
      posterResetJob.cancel();
      return child('1');
    });
    await posterResetJob.resetLibraryPosters('2');
    expect(mocks.getMetadata).toHaveBeenCalledOnce();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Poster reset cancelled during child enumeration',
      expect.objectContaining({ libraryId: '2' })
    );
  });
});

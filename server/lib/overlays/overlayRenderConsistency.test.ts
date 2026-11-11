import type { MaintainerrCollection } from '@server/api/maintainerr';
import type PlexAPI from '@server/api/plexapi';
import type { PlexLibraryItem, PlexMetadata } from '@server/api/plexapi';
import type { OverlayLibraryConfig } from '@server/entity/OverlayLibraryConfig';
import type { OverlayTemplate } from '@server/entity/OverlayTemplate';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: {
    overlays: { posterizarrIntegrationEnabled: false, jpegQuality: 80 },
    plex: { libraries: [] },
  },
  base: vi.fn(),
  writeFile: vi.fn(),
  record: vi.fn(),
}));
vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/lib/settings', () => ({ getSettings: () => mocks.settings }));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('fs/promises', () => ({
  default: {
    writeFile: mocks.writeFile,
    unlink: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('@server/lib/metadata/MetadataTrackingService', () => ({
  default: {
    getItemMetadata: vi.fn().mockResolvedValue(null),
    recordOverlayApplicationWithBasePoster: mocks.record,
  },
}));
vi.mock('@server/lib/placeholders/services/PlaceholderContextService', () => ({
  placeholderContextService: {
    isPlaceholderItemAsync: vi.fn().mockResolvedValue(false),
  },
}));
vi.mock('./OverlayContextBuilder', () => ({
  buildRenderContext: vi.fn().mockResolvedValue({
    context: { title: 'Season 1' },
    criticalApiFailed: false,
  }),
}));
vi.mock('./PlexBasePosterManager', () => ({
  resolveBasePosterSource: () => 'plex',
  resolveBasePosterSourceWithTrail: () => ({ source: 'plex', tried: [] }),
  plexBasePosterManager: { getBasePosterForOverlay: mocks.base },
}));

import * as hashing from '@server/utils/metadataHashing';
import { NO_SEASON_FALLBACK } from './maintainerrCountdown';
import { overlayLibraryService as service } from './OverlayLibraryService';
import { overlayTemplateRenderer } from './OverlayTemplateRenderer';

const renderService = service as unknown as {
  fetchSeasonImdbRatings: (typeof service)['fetchSeasonImdbRatings'];
  applyOverlaysToItem: (typeof service)['applyOverlaysToItem'];
};

describe('overlay render consistency', () => {
  const template = {
    id: 1,
    name: 'Season rating',
    getTags: () => ['target:season'],
    getApplicationCondition: () => undefined,
    getTemplateData: () => ({
      width: 1000,
      height: 1500,
      elements: [
        {
          type: 'variable',
          properties: {
            segments: [
              { type: 'variable', field: 'imdbRating' },
              { type: 'variable', field: 'daysUntilAction' },
            ],
          },
        },
      ],
    }),
  } as unknown as OverlayTemplate;
  const item = {
    ratingKey: 'season-1',
    parentRatingKey: 'show-1',
    title: 'Season 1',
    type: 'season',
    index: 1,
    librarySectionID: '2',
  } as unknown as PlexMetadata;
  const plex = {
    getCurrentPosterUrl: vi.fn().mockResolvedValue('/poster'),
    uploadPosterFromFile: vi.fn(),
    lockPoster: vi.fn(),
    addLabelToItem: vi.fn(),
    getMetadataBatch: vi.fn().mockResolvedValue(new Map([['season-1', item]])),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    'keeps hash, encoded bytes, and filename consistent when the toggle starts %s',
    async (enabled) => {
      mocks.settings.overlays.posterizarrIntegrationEnabled = enabled;
      const image = await sharp({
        create: { width: 16, height: 24, channels: 3, background: '#445566' },
      })
        .png()
        .toBuffer();
      mocks.base.mockImplementation(async () => {
        mocks.settings.overlays.posterizarrIntegrationEnabled = !enabled;
        return {
          posterBuffer: image,
          sourceUrl: '/base',
          filename: 'base.png',
        };
      });
      vi.spyOn(
        overlayTemplateRenderer,
        'renderOverlayElements'
      ).mockResolvedValue([{ input: image, left: 0, top: 0 }]);
      const hash = vi.spyOn(hashing, 'calculateOverlayInputHash');
      await service['applyOverlaysToItem'](
        plex as unknown as PlexAPI,
        item as unknown as PlexLibraryItem,
        [template],
        'show',
        '2',
        'Shows',
        undefined,
        NO_SEASON_FALLBACK
      );
      expect(plex.uploadPosterFromFile).toHaveBeenCalledOnce();
      expect(hash.mock.calls[0][0].renderOptions).toEqual(
        enabled
          ? { format: 'jpeg', jpegQuality: 80, chromaSubsampling: '4:4:4' }
          : undefined
      );
      const [filename, buffer] = mocks.writeFile.mock.calls[0];
      expect(filename).toMatch(enabled ? /\.jpg$/ : /\.webp$/);
      expect((await sharp(buffer).metadata()).format).toBe(
        enabled ? 'jpeg' : 'webp'
      );
      expect(mocks.record.mock.calls[0][2]).toBe(hash.mock.results[0].value);
    }
  );

  it.each([false, true])(
    'only overrides Maintainerr season IMDb context with Posterizarr enabled (%s)',
    async (enabled) => {
      mocks.settings.overlays.posterizarrIntegrationEnabled = enabled;
      const fetchRatings = vi
        .spyOn(renderService, 'fetchSeasonImdbRatings')
        .mockResolvedValue(new Map([['season-1', 8.2]]));
      const apply = vi
        .spyOn(renderService, 'applyOverlaysToItem')
        .mockResolvedValue({ skipped: false });
      const config = {
        libraryId: '2',
        libraryName: 'Shows',
        mediaType: 'show',
        fullSyncTargets: ['main'],
      } as OverlayLibraryConfig;
      const collection = {
        type: 'season',
        deleteAfterDays: 30,
        media: [
          { mediaServerId: 'season-1', addDate: new Date().toISOString() },
        ],
      } as MaintainerrCollection;
      await service['applyMaintainerrSeasonOverlays'](
        plex as unknown as PlexAPI,
        '2',
        config,
        [template],
        { status: 'ok', collections: [collection] }
      );
      expect(apply).toHaveBeenCalledOnce();
      expect(fetchRatings).toHaveBeenCalledTimes(enabled ? 1 : 0);
      const context = apply.mock.calls[0][8];
      if (enabled) expect(context).toHaveProperty('imdbRating', 8.2);
      else expect(context).not.toHaveProperty('imdbRating');
    }
  );

  it.each([false, true])(
    'keeps preloaded full sync season IMDb ratings regardless of the toggle (%s)',
    async (enabled) => {
      mocks.settings.overlays.posterizarrIntegrationEnabled = enabled;
      const fetchRatings = vi
        .spyOn(renderService, 'fetchSeasonImdbRatings')
        .mockResolvedValue(new Map());
      const apply = vi
        .spyOn(renderService, 'applyOverlaysToItem')
        .mockResolvedValue({ skipped: false });
      const config = {
        libraryId: '2',
        libraryName: 'Shows',
        mediaType: 'show',
        fullSyncTargets: ['season'],
      } as OverlayLibraryConfig;
      const collection = {
        type: 'season',
        deleteAfterDays: 30,
        media: [
          { mediaServerId: 'season-1', addDate: new Date().toISOString() },
        ],
      } as MaintainerrCollection;
      await service['applyMaintainerrSeasonOverlays'](
        plex as unknown as PlexAPI,
        '2',
        config,
        [template],
        { status: 'ok', collections: [collection] },
        new Map([['season-1', 7.4]])
      );
      expect(apply).toHaveBeenCalledOnce();
      expect(fetchRatings).not.toHaveBeenCalled();
      expect(apply.mock.calls[0][8]).toHaveProperty('imdbRating', 7.4);
    }
  );
});

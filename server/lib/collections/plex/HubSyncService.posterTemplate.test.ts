import type PlexAPI from '@server/api/plexapi';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.CONFIG_DIRECTORY = fs.mkdtempSync(
  path.join(os.tmpdir(), 'agregarr-hubsync-poster-')
);

const findOne = vi.hoisted(() => vi.fn());
const generatePoster = vi.hoisted(() => vi.fn());
const shouldRegeneratePoster = vi.hoisted(() => vi.fn());

vi.mock('@server/datasource', () => ({
  getRepository: () => ({ findOne }),
}));
vi.mock('@server/entity/PosterTemplate', () => ({ PosterTemplate: class {} }));
vi.mock('@server/lib/posterStorage', () => ({ generatePoster }));
vi.mock('@server/lib/metadata/MetadataTrackingService', () => ({
  default: {
    shouldRegeneratePoster,
    shouldReapplyPoster: vi.fn().mockResolvedValue(false),
    recordPosterApplication: vi.fn(),
  },
}));

const grid = (columns: number, rows: number) => ({
  elements: [{ type: 'content-grid', properties: { columns, rows } }],
});

const defaultRow = (id: number, columns: number, rows: number) => ({
  id,
  templateData: JSON.stringify({ id, columns, rows }),
  getTemplateData: () => grid(columns, rows),
});

describe('pre-existing collection poster with no template saved', () => {
  const plexItems = Array.from({ length: 12 }, (_, i) => ({
    ratingKey: String(i),
    title: `T${i}`,
    type: 'movie',
    Guid: [{ id: `tmdb://${i + 1}` }],
  }));

  const sync = async () => {
    const { default: HubSyncService } = await import('./HubSyncService');
    const plexClient = {
      getCollectionItemsWithMetadata: vi.fn().mockResolvedValue(plexItems),
      getCurrentPosterUrl: vi.fn().mockResolvedValue(undefined),
      updateCollectionPoster: vi.fn(),
    } as unknown as PlexAPI;
    await (
      new HubSyncService() as unknown as {
        syncPreExistingCollections: (
          c: PlexAPI,
          cfgs: object[]
        ) => Promise<void>;
      }
    ).syncPreExistingCollections(plexClient, [
      {
        id: 'pre-1',
        name: 'Neon Noir',
        libraryId: '1',
        mediaType: 'movie',
        collectionRatingKey: '900',
        excludeFromOrdering: true,
        autoPoster: true,
        autoPosterTemplate: null,
      },
    ]);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    shouldRegeneratePoster.mockResolvedValue(true);
    generatePoster.mockResolvedValue(null);
  });

  it('sizes the grid from the default template', async () => {
    findOne.mockResolvedValue(defaultRow(5, 2, 2));
    await sync();
    expect(generatePoster.mock.calls[0][0].items).toHaveLength(4);
  });

  it('changes the hash when the default template changes', async () => {
    const hashes: string[] = [];
    shouldRegeneratePoster.mockImplementation(async (_rk, hash) => {
      hashes.push(hash);
      return true;
    });
    findOne.mockResolvedValue(defaultRow(5, 3, 3));
    await sync();
    findOne.mockResolvedValue(defaultRow(6, 3, 3));
    await sync();
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).not.toBe(hashes[1]);
  });
});

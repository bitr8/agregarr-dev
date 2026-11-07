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
  templateEngine: {},
}));
vi.mock('./overseerr', () => ({ overseerrCollectionService: {} }));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    plex: {
      collectionConfigs: [],
      libraries: [{ key: '4', type: 'show' }],
    },
    save: vi.fn(),
  }),
}));

import { OverseerrCollectionSync } from './overseerrSync';

const item = (ratingKey: string, userId: number, createdAt: string) => ({
  ratingKey,
  title: `Show ${ratingKey}`,
  type: 'tv' as const,
  userId,
  requestId: 1,
  createdAt,
});

const missing = (tmdbId: number, userId: number) => ({
  tmdbId,
  mediaType: 'tv' as const,
  title: `Missing ${tmdbId}`,
  originalPosition: 1,
  source: 'tmdb',
  userId,
});

describe('OverseerrCollectionSync user collections: repeated requests', () => {
  it('lists a show once, spends one maxItems slot on it, and keeps it for each user', async () => {
    const sync = new OverseerrCollectionSync();
    const createCollection = (
      vi.spyOn(
        sync as unknown as { createCollection: unknown },
        'createCollection' as never
      ) as unknown as MockInstance
    ).mockResolvedValue({ created: 1, updated: 0 } as never);
    (
      vi.spyOn(
        sync as unknown as { createUserCollectionName: unknown },
        'createUserCollectionName' as never
      ) as unknown as MockInstance
    ).mockResolvedValue('Kaylyn TV' as never);

    const cfg = {
      id: 'c1',
      type: 'overseerr',
      subtype: 'users',
      mediaType: 'tv',
      libraryId: '4',
      maxItems: 2,
    } as unknown as CollectionConfig;

    const run = (user: number) =>
      (
        sync as unknown as {
          processUserCollection: (...a: unknown[]) => Promise<unknown>;
        }
      ).processUserCollection(
        {
          user: { id: user },
          movies: [],
          tv: [
            item('100', user, '2026-09-03'),
            item('100', user, '2026-09-02'),
            item('200', user, '2026-09-01'),
          ],
          missingItems: [missing(7, user), missing(7, user), missing(8, user)],
        },
        cfg,
        {} as PlexAPI,
        []
      );

    await run(1);
    await run(2);

    for (const call of createCollection.mock.calls) {
      const items = call[0] as { ratingKey: string }[];
      expect(items.map((i) => i.ratingKey)).toEqual(['100', '200']);
      const miss = call[8] as { tmdbId: number }[];
      expect(miss.map((m) => m.tmdbId)).toEqual([7, 8]);
    }
    expect(createCollection).toHaveBeenCalledTimes(2);
  });
});

import type { CollectionConfig } from '@server/lib/settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the modules that trigger TypeORM entity loading
vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/entity/User', () => ({ User: class {} }));
vi.mock('@server/lib/collections/utils/TemplateEngine', () => ({
  templateEngine: {},
}));
vi.mock('@server/logger', () => ({
  default: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const save = vi.fn();
const settings = {
  plex: { collectionConfigs: [] as CollectionConfig[] },
  save,
};

vi.mock('@server/lib/settings', () => ({
  getSettings: () => settings,
}));

import {
  clearConfigRatingKey,
  hasAgregarrLabel,
  isMultiCollectionPattern,
} from './CollectionUtilities';

const config = (overrides: Partial<CollectionConfig>): CollectionConfig =>
  ({ id: 'cfg-1', libraryId: '4', ...overrides } as CollectionConfig);

const stored = () =>
  settings.plex.collectionConfigs[0] as CollectionConfig & {
    collectionRatingKeys?: string[];
  };

describe('clearConfigRatingKey', () => {
  beforeEach(() => {
    save.mockClear();
    settings.plex.collectionConfigs = [];
  });

  it('clears a matching singular ratingKey', () => {
    settings.plex.collectionConfigs = [
      config({ collectionRatingKey: '398348' }),
    ];

    clearConfigRatingKey('cfg-1', '4', '398348');

    expect(stored().collectionRatingKey).toBeUndefined();
    expect(save).toHaveBeenCalled();
  });

  it('leaves a singular ratingKey alone when a different key went stale', () => {
    settings.plex.collectionConfigs = [
      config({ collectionRatingKey: '111111' }),
    ];

    clearConfigRatingKey('cfg-1', '4', '398348');

    expect(stored().collectionRatingKey).toBe('111111');
  });

  it('does not write settings when nothing changed', () => {
    settings.plex.collectionConfigs = [
      config({ collectionRatingKey: '111111' }),
    ];

    clearConfigRatingKey('cfg-1', '4', '398348');

    expect(save).not.toHaveBeenCalled();
  });

  it('does not write settings when the stale key is absent from the array', () => {
    settings.plex.collectionConfigs = [
      config({
        collectionRatingKeys: ['111111', '222222'],
      } as Partial<CollectionConfig>),
    ];

    clearConfigRatingKey('cfg-1', '4', '398348');

    expect(save).not.toHaveBeenCalled();
    expect(stored().collectionRatingKeys).toEqual(['111111', '222222']);
  });

  it('removes only the stale key from a multi-collection config', () => {
    // Overseerr per-user configs hold one ratingKey per user. Clearing one
    // dead collection must not discard every other user's collection.
    settings.plex.collectionConfigs = [
      config({
        collectionRatingKeys: ['111111', '398348', '222222'],
      } as Partial<CollectionConfig>),
    ];

    clearConfigRatingKey('cfg-1', '4', '398348');

    expect(stored().collectionRatingKeys).toEqual(['111111', '222222']);
  });

  it('does nothing when the libraryId does not match', () => {
    settings.plex.collectionConfigs = [
      config({ collectionRatingKey: '398348' }),
    ];

    clearConfigRatingKey('cfg-1', '9', '398348');

    expect(stored().collectionRatingKey).toBe('398348');
    expect(save).not.toHaveBeenCalled();
  });

  it('clears the singular key when no stale key is named (legacy callers)', () => {
    settings.plex.collectionConfigs = [
      config({ collectionRatingKey: '398348' }),
    ];

    clearConfigRatingKey('cfg-1', '4');

    expect(stored().collectionRatingKey).toBeUndefined();
  });
});

describe('hasAgregarrLabel', () => {
  it('matches the hyphenated labels parseConfigIdFromLabel rejects', () => {
    // Regression: routing multi-source deletes through parseConfigIdFromLabel
    // silently stopped removing these collections.
    expect(hasAgregarrLabel(['agregarr-multisource-10213'])).toBe(true);
    expect(hasAgregarrLabel(['Agregarr-filtered_hub-10214'])).toBe(true);
  });

  it('matches camel-case labels', () => {
    expect(hasAgregarrLabel(['AgregarrTmdb10213'])).toBe(true);
  });

  it('reads the tag shape Plex returns for raw collections', () => {
    expect(hasAgregarrLabel([{ tag: 'agregarr-multisource-1' }])).toBe(true);
    expect(hasAgregarrLabel([{ tag: 'horror' }])).toBe(false);
  });

  // The whole point: a user collection is refused however plausible it looks.
  // "Same title" and "not a smart collection" are not ownership evidence.
  it('refuses a user collection regardless of title or smart flag', () => {
    expect(hasAgregarrLabel(['favourites'])).toBe(false);
    expect(hasAgregarrLabel([])).toBe(false);
    expect(hasAgregarrLabel(undefined)).toBe(false);
  });
});

describe('isMultiCollectionPattern', () => {
  it('names the two configs that generate more than one collection', () => {
    expect(
      isMultiCollectionPattern({ type: 'overseerr', subtype: 'users' })
    ).toBe(true);
    expect(
      isMultiCollectionPattern({ type: 'tmdb', subtype: 'auto_franchise' })
    ).toBe(true);
  });

  // The presence half: everything else must store its key, or the create path
  // has nothing to recover from.
  it('lets ordinary configs store a key', () => {
    expect(
      isMultiCollectionPattern({ type: 'tmdb', subtype: 'trending' })
    ).toBe(false);
    expect(
      isMultiCollectionPattern({ type: 'overseerr', subtype: 'requests' })
    ).toBe(false);
    expect(isMultiCollectionPattern({ type: 'plex' })).toBe(false);
    expect(isMultiCollectionPattern(undefined)).toBe(false);
  });

  it('does not match on the subtype alone', () => {
    expect(isMultiCollectionPattern({ type: 'plex', subtype: 'users' })).toBe(
      false
    );
  });
});

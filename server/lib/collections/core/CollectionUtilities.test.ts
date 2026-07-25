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
  shouldAdoptByTitle,
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

describe('shouldAdoptByTitle', () => {
  const base = {
    title: 'Horror Movies',
    titleCandidates: ['Horror Movies'],
    collectionName: 'Horror Movies',
  };

  it('adopts an unlabeled regular collection (failed-creation orphan)', () => {
    expect(
      shouldAdoptByTitle({ ...base, isSmart: false, hasAgregarrLabel: false })
    ).toBe(true);
  });

  it('refuses an unlabeled smart collection (the user built it)', () => {
    expect(
      shouldAdoptByTitle({ ...base, isSmart: true, hasAgregarrLabel: false })
    ).toBe(false);
  });

  it('adopts a labeled smart collection (showUnwatchedOnly re-find)', () => {
    expect(
      shouldAdoptByTitle({ ...base, isSmart: true, hasAgregarrLabel: true })
    ).toBe(true);
  });

  it('adopts a labeled regular collection (config ID change orphan)', () => {
    expect(
      shouldAdoptByTitle({ ...base, isSmart: false, hasAgregarrLabel: true })
    ).toBe(true);
  });

  it('refuses any collection whose title does not match', () => {
    expect(
      shouldAdoptByTitle({
        ...base,
        title: 'Something Else',
        isSmart: false,
        hasAgregarrLabel: true,
      })
    ).toBe(false);
  });

  it('refuses an unlabeled collection matching config.name but not collectionName', () => {
    expect(
      shouldAdoptByTitle({
        title: 'Config Name',
        titleCandidates: ['Config Name', 'Rendered Name'],
        collectionName: 'Rendered Name',
        isSmart: false,
        hasAgregarrLabel: false,
      })
    ).toBe(false);
  });

  // Plex data: if title were also missing, strict-equal on two undefineds
  // would adopt, so the collectionName guard has to carry this one.
  it('refuses an unlabeled collection when both title and collectionName are absent', () => {
    const missing = undefined as unknown as string;
    expect(
      shouldAdoptByTitle({
        title: missing,
        titleCandidates: [missing],
        collectionName: undefined,
        isSmart: false,
        hasAgregarrLabel: false,
      })
    ).toBe(false);
  });
});

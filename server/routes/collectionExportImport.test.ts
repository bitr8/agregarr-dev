import type { CollectionConfig } from '@server/lib/settings';
import { describe, expect, it } from 'vitest';
import {
  buildConfigFromImport,
  buildExportPayload,
  migrateDeprecatedFields,
} from './collectionExportImport';

function makeConfig(overrides?: Partial<CollectionConfig>): CollectionConfig {
  return {
    id: '10001',
    name: 'Test Collection',
    type: 'tmdb',
    subtype: 'trending',
    libraryId: '1',
    libraryName: 'Movies',
    collectionRatingKey: '99999',
    sortOrderHome: 5,
    sortOrderLibrary: 3,
    ...overrides,
  } as CollectionConfig;
}

describe('migrateDeprecatedFields', () => {
  it('maps comingSoonDays to placeholderDaysAhead', () => {
    const result = migrateDeprecatedFields({ comingSoonDays: 90 });
    expect(result.placeholderDaysAhead).toBe(90);
  });

  it('maps comingSoonReleasedDays to placeholderReleasedDays', () => {
    const result = migrateDeprecatedFields({ comingSoonReleasedDays: 14 });
    expect(result.placeholderReleasedDays).toBe(14);
  });

  it('does not overwrite existing placeholder fields', () => {
    const result = migrateDeprecatedFields({
      comingSoonDays: 90,
      placeholderDaysAhead: 30,
    });
    expect(result.placeholderDaysAhead).toBe(30);
  });

  it('passes through configs with no deprecated fields unchanged', () => {
    const input = { name: 'Test', type: 'tmdb' };
    const result = migrateDeprecatedFields(input);
    expect(result).toEqual(input);
  });
});

describe('buildExportPayload', () => {
  it('strips instance-bound fields', () => {
    const result = buildExportPayload(makeConfig());
    expect(result).not.toHaveProperty('id');
    expect(result).not.toHaveProperty('libraryId');
    expect(result).not.toHaveProperty('libraryName');
    expect(result).not.toHaveProperty('collectionRatingKey');
  });

  it('keeps portable fields', () => {
    const result = buildExportPayload(
      makeConfig({ name: 'Trending', type: 'tmdb', subtype: 'trending' })
    );
    expect(result.name).toBe('Trending');
    expect(result.type).toBe('tmdb');
    expect(result.subtype).toBe('trending');
  });

  it('resets sort positions to 0', () => {
    const result = buildExportPayload(
      makeConfig({ sortOrderHome: 5, sortOrderLibrary: 3 })
    );
    expect(result.sortOrderHome).toBe(0);
    expect(result.sortOrderLibrary).toBe(0);
  });

  it('migrates deprecated comingSoonDays to placeholderDaysAhead', () => {
    const result = buildExportPayload(
      makeConfig({
        comingSoonDays: 90,
      } as Partial<CollectionConfig> as CollectionConfig)
    );
    expect(result.placeholderDaysAhead).toBe(90);
    expect(result).not.toHaveProperty('comingSoonDays');
  });

  it('cleans source IDs and strips non-portable source fields', () => {
    const result = buildExportPayload(
      makeConfig({
        isMultiSource: true,
        sources: [
          {
            id: '50001',
            name: 'Source 1',
            type: 'tmdb',
            subtype: 'trending',
            priority: 1,
            libraryId: '1',
            collectionRatingKey: '88888',
          } as unknown,
        ] as CollectionConfig['sources'],
      })
    );
    const sources = result.sources as Record<string, unknown>[];
    expect(sources).toHaveLength(1);
    expect(sources[0]).not.toHaveProperty('libraryId');
    expect(sources[0]).not.toHaveProperty('collectionRatingKey');
    expect(sources[0]).not.toHaveProperty('name');
    expect(sources[0].type).toBe('tmdb');
    expect(sources[0].id).toBe('1');
  });

  it('strips customSyncSchedule runtime fields', () => {
    const result = buildExportPayload(
      makeConfig({
        customSyncSchedule: {
          enabled: true,
          preset: '12h',
          firstSyncAt: '2026-01-01T00:00:00Z',
          startNow: true,
        } as CollectionConfig['customSyncSchedule'],
      })
    );
    const schedule = result.customSyncSchedule as Record<string, unknown>;
    expect(schedule.enabled).toBe(true);
    expect(schedule.preset).toBe('12h');
    expect(schedule).not.toHaveProperty('firstSyncAt');
    expect(schedule).not.toHaveProperty('startNow');
  });
});

describe('buildConfigFromImport', () => {
  it('mints the provided ID, never adopts embedded', () => {
    const config = buildConfigFromImport(
      { name: 'Test', type: 'tmdb', id: '99999' },
      '10050',
      '2',
      'TV Shows'
    );
    expect(config.id).toBe('10050');
  });

  it('sets needsSync and lastModifiedAt', () => {
    const config = buildConfigFromImport(
      { name: 'Test', type: 'tmdb' },
      '10050',
      '2',
      'TV Shows'
    );
    expect(config.needsSync).toBe(true);
    expect(config.lastModifiedAt).toBeTruthy();
  });

  it('resets sort positions to 0', () => {
    const config = buildConfigFromImport(
      { name: 'Test', type: 'tmdb', sortOrderHome: 5, sortOrderLibrary: 3 },
      '10050',
      '2',
      'TV Shows'
    );
    expect(config.sortOrderHome).toBe(0);
    expect(config.sortOrderLibrary).toBe(0);
  });

  it('applies name override', () => {
    const config = buildConfigFromImport(
      { name: 'Original', type: 'tmdb' },
      '10050',
      '2',
      'TV Shows',
      'Overridden'
    );
    expect(config.name).toBe('Overridden');
  });

  it('only accepts portable fields, ignores instance-bound', () => {
    const config = buildConfigFromImport(
      {
        name: 'Test',
        type: 'tmdb',
        collectionRatingKey: '99999',
        radarrInstanceId: 'abc',
        lastSyncedAt: '2026-01-01',
      },
      '10050',
      '2',
      'TV Shows'
    );
    expect(config.collectionRatingKey).toBeUndefined();
    expect(config.lastSyncedAt).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import {
  getPlaceholderHubSubtypes,
  getSuggestedFilteredHubLabel,
  libraryIdsForPresetMediaType,
  normaliseSavedTemplate,
  resolveDisplayedPosterTemplateId,
  resolveTemplateFix,
  supportsTargetUser,
  withDefaultInactiveVisibility,
} from './collectionFormRules';

describe('supportsTargetUser', () => {
  it('is off where the server ignores it', () => {
    expect(supportsTargetUser('overseerr', 'users')).toBe(false);
    expect(supportsTargetUser('tmdb', 'auto_franchise')).toBe(false);
    for (const s of ['genres', 'actors', 'directors', 'separator']) {
      expect(supportsTargetUser('plex', s)).toBe(false);
    }
  });

  it('is on for label collections and ordinary sources', () => {
    expect(supportsTargetUser('plex', 'label')).toBe(true);
    expect(supportsTargetUser('trakt', 'trending')).toBe(true);
    expect(supportsTargetUser('tmdb', 'trending_day')).toBe(true);
    expect(supportsTargetUser('filtered_hub', 'recently_added')).toBe(true);
  });
});

describe('libraryIdsForPresetMediaType', () => {
  const libs = [
    { key: '1', type: 'movie' },
    { key: '2', type: 'show' },
    { key: '3', type: 'movie' },
    { key: '4', type: 'artist' },
  ];

  it('keeps selected libraries of the matching type', () => {
    expect(
      libraryIdsForPresetMediaType(['1', '2', '3'], libs, 'movie')
    ).toEqual(['1', '3']);
    expect(libraryIdsForPresetMediaType(['1', '2'], libs, 'tv')).toEqual(['2']);
  });

  it('preselects every matching library when none of the selection matches', () => {
    expect(libraryIdsForPresetMediaType([], libs, 'movie')).toEqual(['1', '3']);
    expect(libraryIdsForPresetMediaType(['2'], libs, 'movie')).toEqual([
      '1',
      '3',
    ]);
    expect(libraryIdsForPresetMediaType(['all'], libs, 'tv')).toEqual(['2']);
  });
});

describe('normaliseSavedTemplate', () => {
  const presets = ['{value}', 'Trending', 'custom'];

  it('leaves a preset value alone', () => {
    expect(normaliseSavedTemplate('Trending', presets, true, true)).toBeNull();
  });

  it('picks the first preset when empty', () => {
    expect(normaliseSavedTemplate('', presets, true, true)).toEqual({
      template: '{value}',
    });
  });

  it('keeps a saved non-preset string as the custom template for every selected type', () => {
    expect(
      normaliseSavedTemplate('Recently Added Movies', presets, true, true)
    ).toEqual({
      template: 'custom',
      customMovieTemplate: 'Recently Added Movies',
      customTVTemplate: 'Recently Added Movies',
    });
    expect(normaliseSavedTemplate('Old', presets, false, true)).toEqual({
      template: 'custom',
      customTVTemplate: 'Old',
    });
  });

  it('fills both when no library type is known yet', () => {
    expect(normaliseSavedTemplate('Old', presets, false, false)).toEqual({
      template: 'custom',
      customMovieTemplate: 'Old',
      customTVTemplate: 'Old',
    });
  });

  it('falls back to the first preset when custom is not offered', () => {
    expect(normaliseSavedTemplate('Old', ['A', 'B'], true, true)).toEqual({
      template: 'A',
    });
  });

  it('does nothing without presets', () => {
    expect(normaliseSavedTemplate('x', [], true, true)).toBeNull();
  });
});

describe('placeholder hub mapping', () => {
  it('accepts the episode subtypes for tv.recentlyadded', () => {
    const s = getPlaceholderHubSubtypes('tv.recentlyadded');
    expect(s).toEqual(
      expect.arrayContaining([
        'recently_released_episodes',
        'recently_added_episodes',
        'recently_added',
      ])
    );
    expect(s).not.toContain('recently_aired_episodes');
  });

  it('keeps recently aired apart from added', () => {
    expect(getPlaceholderHubSubtypes('tv.recentlyaired')).toEqual([
      'recently_aired_episodes',
      'recently_released_episodes',
    ]);
    expect(getPlaceholderHubSubtypes('movie.recentlyadded')).toEqual([
      'recently_added',
    ]);
    expect(getPlaceholderHubSubtypes('nope')).toBeUndefined();
  });

  it('suggests the episode subtype for tv', () => {
    expect(getSuggestedFilteredHubLabel('tv.recentlyadded', 'X')).toBe(
      'Recently Added Episodes'
    );
    expect(
      getSuggestedFilteredHubLabel(
        'movie.recentlyadded',
        'Recently Added Movies'
      )
    ).toBe('Recently Added Movies');
  });
});

describe('withDefaultInactiveVisibility', () => {
  it('fills a missing key', () => {
    expect(withDefaultInactiveVisibility({ alwaysActive: true })).toEqual({
      alwaysActive: true,
      inactiveVisibilityConfig: {
        usersHome: false,
        serverOwnerHome: false,
        libraryRecommended: true,
      },
    });
  });

  it('keeps an existing one and handles absence', () => {
    const tr = {
      alwaysActive: false,
      inactiveVisibilityConfig: {
        usersHome: true,
        serverOwnerHome: false,
        libraryRecommended: false,
      },
    };
    expect(withDefaultInactiveVisibility(tr)).toEqual(tr);
    expect(withDefaultInactiveVisibility(undefined).alwaysActive).toBe(true);
  });
});

describe('resolveDisplayedPosterTemplateId', () => {
  const templates = [
    { id: 1, name: 'Default Agregarr Template', isDefault: true },
    { id: 2, name: 'Separator', isDefault: false },
    { id: 3, name: 'Mine', isDefault: false },
  ];

  it('shows the built-in Separator for a separator with nothing saved', () => {
    expect(resolveDisplayedPosterTemplateId(null, true, templates)).toBe(2);
  });

  it('shows the default for everything else', () => {
    expect(resolveDisplayedPosterTemplateId(undefined, false, templates)).toBe(
      1
    );
  });

  it('keeps a saved choice', () => {
    expect(resolveDisplayedPosterTemplateId(3, true, templates)).toBe(3);
  });

  it('falls back to the default when no Separator template exists', () => {
    expect(resolveDisplayedPosterTemplateId(null, true, [templates[0]])).toBe(
      1
    );
    expect(resolveDisplayedPosterTemplateId(null, true, undefined)).toBeNull();
  });
});

describe('resolveTemplateFix', () => {
  const base = { hasMovieLib: true, hasTVLib: true };

  it('create form: a preset-list change falls back to the first preset, never Custom', () => {
    expect(
      resolveTemplateFix({
        ...base,
        template: 'Trakt Trending',
        presetValues: ['Trakt Popular', 'custom'],
        pendingEditConversion: false,
      })
    ).toEqual({ fix: { template: 'Trakt Popular' }, settled: true });
  });

  it('create form: leaves a valid preset alone', () => {
    expect(
      resolveTemplateFix({
        ...base,
        template: 'custom',
        presetValues: ['A', 'custom'],
        pendingEditConversion: false,
      })
    ).toEqual({ fix: null, settled: true });
  });

  it('edit load: converts a saved non-preset title to Custom once', () => {
    const first = resolveTemplateFix({
      ...base,
      template: 'My Old Title',
      presetValues: ['A', 'custom'],
      pendingEditConversion: true,
    });
    expect(first).toEqual({
      fix: {
        template: 'custom',
        customMovieTemplate: 'My Old Title',
        customTVTemplate: 'My Old Title',
      },
      settled: true,
    });
    expect(
      resolveTemplateFix({
        ...base,
        template: 'A',
        presetValues: ['B', 'custom'],
        pendingEditConversion: !first.settled,
      })
    ).toEqual({ fix: { template: 'B' }, settled: true });
  });

  it('edit load: waits while fetched-title presets are still loading', () => {
    expect(
      resolveTemplateFix({
        ...base,
        template: 'Saved List Title',
        presetValues: ['fetch-title', 'custom'],
        pendingEditConversion: true,
      })
    ).toEqual({ fix: null, settled: false });
    expect(
      resolveTemplateFix({
        ...base,
        template: 'Saved List Title',
        presetValues: ['Saved List Title', 'custom'],
        pendingEditConversion: true,
      })
    ).toEqual({ fix: null, settled: true });
  });

  it('does nothing before any presets exist', () => {
    expect(
      resolveTemplateFix({
        ...base,
        template: 'x',
        presetValues: [],
        pendingEditConversion: true,
      })
    ).toEqual({ fix: null, settled: false });
  });
});

describe('resolveTemplateFix source change', () => {
  it('drops a pending edit conversion once the user switches source', () => {
    const { fix, settled } = resolveTemplateFix({
      template: 'Old Fetched List',
      presetValues: ['popular-a', 'fetch-title', 'custom'],
      hasMovieLib: true,
      hasTVLib: false,
      pendingEditConversion: true,
      sourceChanged: true,
    });
    expect(fix).toEqual({ template: 'popular-a' });
    expect(settled).toBe(true);
  });
});

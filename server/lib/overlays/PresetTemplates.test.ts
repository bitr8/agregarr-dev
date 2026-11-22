import { extractUsedContextFields } from '@server/utils/metadataHashing';
import { describe, expect, it } from 'vitest';

import { getDefaultMappings } from './DefaultMappingsService';
import { evaluateCondition } from './OverlayTemplateRenderer';
import { PRESET_TEMPLATES } from './PresetTemplates';
import { createSampleOverlayContext } from './sampleOverlayContext';

describe('Audio Codec preset', () => {
  const preset = PRESET_TEMPLATES.find((p) => p.name === 'Audio Codec');

  it('exists with a unique name', () => {
    expect(preset).toBeDefined();
    expect(
      PRESET_TEMPLATES.filter((p) => p.name === 'Audio Codec')
    ).toHaveLength(1);
  });

  it('only applies to non-show items with a detected audio profile', () => {
    expect(preset?.applicationCondition?.sections?.[0]?.rules).toEqual([
      { field: 'audioProfile', operator: 'exists', value: true },
      {
        ruleOperator: 'and',
        field: 'mediaType',
        operator: 'neq',
        value: 'show',
      },
    ]);
  });

  it('does not apply to shows even when episodes roll up a profile', () => {
    expect(
      evaluateCondition(preset?.applicationCondition, {
        isPlaceholder: false,
        mediaType: 'show',
        audioProfile: 'truehd_atmos',
      })
    ).toBe(false);
  });

  it('skips items with no detectable audio and applies when detected', () => {
    const base = { isPlaceholder: false, mediaType: 'movie' as const };
    expect(evaluateCondition(preset?.applicationCondition, base)).toBe(false);
    expect(
      evaluateCondition(preset?.applicationCondition, {
        ...base,
        audioProfile: 'truehd_atmos',
      })
    ).toBe(true);
  });

  it('previews for movies and shows (shows roll it up from episodes)', () => {
    expect(createSampleOverlayContext('movie').audioProfile).toBe(
      'truehd_atmos'
    );
    expect(createSampleOverlayContext('show').audioProfile).toBe(
      'truehd_atmos'
    );
  });

  it('participates in the overlay input hash via usedFields', () => {
    expect(
      extractUsedContextFields(
        [preset!.templateData],
        [preset!.applicationCondition]
      )
    ).toContain('audioProfile');
  });

  it('renders a single mapped icon driven by audioProfile', () => {
    const elements = preset?.templateData.elements ?? [];
    expect(elements).toHaveLength(1);
    const element = elements[0] as {
      type: string;
      properties: { field: string; maxIcons: number; mappings: unknown[] };
    };
    expect(element.type).toBe('mapped-icon');
    expect(element.properties.field).toBe('audioProfile');
    expect(element.properties.maxIcons).toBe(1);
    // Empty snapshot on purpose: renderer falls back to merged mappings, so
    // this preset honours user edits without a re-save. The hash also folds
    // in those merged mappings (metadataHashing.ts), so an edit still
    // triggers regeneration.
    expect(element.properties.mappings).toEqual([]);
  });
});

describe('Resolution preset', () => {
  const preset = PRESET_TEMPLATES.find((p) => p.name === 'Resolution');

  it('exists with a unique name', () => {
    expect(preset).toBeDefined();
    expect(
      PRESET_TEMPLATES.filter((p) => p.name === 'Resolution')
    ).toHaveLength(1);
  });

  it('applies to every Plex resolution tier and skips unknown values', () => {
    const base = { isPlaceholder: false, mediaType: 'movie' as const };
    for (const resolution of ['4k', '1080', '720', '576', '480', 'sd']) {
      expect(
        evaluateCondition(preset?.applicationCondition, { ...base, resolution })
      ).toBe(true);
    }
    expect(evaluateCondition(preset?.applicationCondition, base)).toBe(false);
    expect(
      evaluateCondition(preset?.applicationCondition, {
        ...base,
        resolution: 'unknown',
      })
    ).toBe(false);
  });

  it('renders a single mapped icon driven by resolution', () => {
    const elements = preset?.templateData.elements ?? [];
    expect(elements).toHaveLength(1);
    const element = elements[0] as {
      type: string;
      properties: { field: string; maxIcons: number; mappings: unknown[] };
    };
    expect(element.type).toBe('mapped-icon');
    expect(element.properties.field).toBe('resolution');
    expect(element.properties.maxIcons).toBe(1);
    expect(element.properties.mappings).toEqual([]);
  });

  it('participates in the overlay input hash via usedFields', () => {
    expect(
      extractUsedContextFields(
        [preset!.templateData],
        [preset!.applicationCondition]
      )
    ).toContain('resolution');
  });

  it('has a default icon for every tier that ships an icon asset', () => {
    const values = getDefaultMappings('resolution').map((m) => m.value);
    for (const resolution of ['4k', '1080', '720', '576', '480']) {
      expect(values).toContain(resolution);
    }
  });
});

describe('sd resolution icon', () => {
  it('has a default mapping so SD items get a badge', () => {
    expect(
      getDefaultMappings('resolution').find((m) => m.value === 'sd')
    ).toEqual({
      value: 'sd',
      iconPath: expect.stringContaining('/resolution/sd.png'),
    });
  });
});

describe('Awaiting Download preset', () => {
  const preset = PRESET_TEMPLATES.find((p) => p.name === 'Awaiting Download');

  it('does not match a TV show whose deleted episodes were just unmonitored', () => {
    const context = {
      isPlaceholder: false,
      mediaType: 'show' as const,
      daysAgo: 5,
      downloaded: false,
      isMonitored: true,
      inSonarr: true,
      missingEpisodeCount: 0,
    };
    expect(evaluateCondition(preset?.applicationCondition, context)).toBe(
      false
    );
  });

  it('matches a TV show still genuinely awaiting download', () => {
    const context = {
      isPlaceholder: false,
      mediaType: 'show' as const,
      daysAgo: 5,
      downloaded: false,
      isMonitored: true,
      inSonarr: true,
      missingEpisodeCount: 3,
    };
    expect(evaluateCondition(preset?.applicationCondition, context)).toBe(true);
  });
});

describe('Episode Info - Episode Card preset', () => {
  const name = 'Episode Info - Episode Card';
  const preset = PRESET_TEMPLATES.find((p) => p.name === name);

  it('ships once, tagged for episode cards on a 1920x1080 canvas', () => {
    expect(PRESET_TEMPLATES.filter((p) => p.name === name)).toHaveLength(1);
    expect(preset?.tags).toContain('target:episode');
    expect(preset?.templateData).toMatchObject({ width: 1920, height: 1080 });
  });

  it('leaves the existing presets at their display order', () => {
    const index = (n: string) =>
      PRESET_TEMPLATES.findIndex((p) => p.name === n);
    expect(index('IMDb Rating')).toBe(0);
    expect(index('IMDb Rating - Season Poster')).toBe(1);
    expect(index('Resolution')).toBe(40);
    expect(index(name)).toBe(41);
  });

  it('puts a badge bottom right that reads S01E01', () => {
    const els = preset?.templateData.elements ?? [];
    const tile = els.find((e) => e.type === 'tile');
    const text = els.find((e) => e.type === 'variable');
    expect(tile).toMatchObject({ x: 1600, y: 945, width: 305, height: 105 });
    expect(tile?.properties).toMatchObject({
      fillColor: '#000000',
      fillOpacity: 60,
    });
    expect(text).toMatchObject({ x: 1600, y: 945, width: 305, height: 105 });
    expect(text?.properties).toMatchObject({
      fontSize: 55,
      color: '#ffffff',
      textAlign: 'center',
      segments: [
        { type: 'text', value: 'S' },
        { type: 'variable', field: 'seasonNumber', format: 'pad2' },
        { type: 'text', value: 'E' },
        { type: 'variable', field: 'episodeNumber', format: 'pad2' },
      ],
    });
  });

  it('applies only when both numbers exist, specials included', () => {
    const cond = preset?.applicationCondition;
    const base = { isPlaceholder: false, mediaType: 'show' as const };
    expect(
      evaluateCondition(cond, { ...base, seasonNumber: 1, episodeNumber: 1 })
    ).toBe(true);
    expect(
      evaluateCondition(cond, { ...base, seasonNumber: 0, episodeNumber: 1 })
    ).toBe(true);
    expect(evaluateCondition(cond, { ...base, seasonNumber: 1 })).toBe(false);
    expect(evaluateCondition(cond, { ...base, episodeNumber: 1 })).toBe(false);
  });

  it('participates in the overlay input hash via season and episode numbers', () => {
    const used = extractUsedContextFields(
      [preset?.templateData as never],
      [preset?.applicationCondition as never]
    );
    expect(used.has('seasonNumber')).toBe(true);
    expect(used.has('episodeNumber')).toBe(true);
    expect(used.has('imdbRating')).toBe(false);
  });
});

describe('Multiple Versions presets', () => {
  const cases = [
    {
      name: 'Multiple Versions',
      tag: undefined,
      width: 1000,
      height: 1500,
      tile: { x: 880, y: 1060 },
    },
    {
      name: 'Multiple Versions - Season Poster',
      tag: 'target:season',
      width: 1000,
      height: 1500,
      tile: { x: 880, y: 1060 },
    },
    {
      name: 'Multiple Versions - Episode Card',
      tag: 'target:episode',
      width: 1920,
      height: 1080,
      tile: { x: 1143, y: 705 },
    },
  ];

  it('are appended after the existing presets, in this order', () => {
    const index = (n: string) =>
      PRESET_TEMPLATES.findIndex((p) => p.name === n);
    expect(index('Episode Info - Episode Card')).toBe(41);
    expect(cases.map((c) => index(c.name))).toEqual([42, 43, 44]);
    expect(PRESET_TEMPLATES).toHaveLength(45);
  });

  it('leave every earlier preset untouched by the new fields', () => {
    for (const p of PRESET_TEMPLATES.slice(0, 42)) {
      const used = extractUsedContextFields(
        [p.templateData as never],
        [p.applicationCondition as never]
      );
      for (const field of [
        'versionCount',
        'hasMultipleVersions',
        'episodeMultiVersionCount',
      ]) {
        expect(used.has(field), `${p.name} ${field}`).toBe(false);
      }
    }
  });

  for (const c of cases) {
    describe(c.name, () => {
      const preset = PRESET_TEMPLATES.find((p) => p.name === c.name);

      it('ships once on the right canvas and target', () => {
        expect(PRESET_TEMPLATES.filter((p) => p.name === c.name)).toHaveLength(
          1
        );
        expect(preset?.templateData).toMatchObject({
          width: c.width,
          height: c.height,
        });
        const targets = (preset?.tags ?? []).filter((t) =>
          t.startsWith('target:')
        );
        expect(targets).toEqual(c.tag ? [c.tag] : []);
      });

      it('draws a 105 square rounded tile with the copy icon on it', () => {
        const els = preset?.templateData.elements ?? [];
        const tile = els.find((e) => e.type === 'tile');
        const icon = els.find((e) => e.type === 'svg');
        expect(tile).toMatchObject({ ...c.tile, width: 105, height: 105 });
        expect(tile?.properties).toMatchObject({
          fillColor: '#000000',
          fillOpacity: 60,
          borderRadiusTopLeft: 30,
          borderRadiusTopRight: 30,
          borderRadiusBottomLeft: 30,
          borderRadiusBottomRight: 30,
        });
        expect(icon?.properties).toMatchObject({
          iconType: 'custom-icon',
          iconPath: '/api/v1/posters/icons/system/content-copy.svg',
        });
        expect(icon!.x).toBeGreaterThan(c.tile.x);
        expect(icon!.x + icon!.width).toBeLessThan(c.tile.x + 105);
        expect(icon!.y).toBeGreaterThan(c.tile.y);
        expect(icon!.y + icon!.height).toBeLessThan(c.tile.y + 105);
      });

      it('applies only to items that have several versions', () => {
        const cond = preset?.applicationCondition;
        const base = { isPlaceholder: false, mediaType: 'movie' as const };
        expect(
          evaluateCondition(cond, { ...base, hasMultipleVersions: true })
        ).toBe(true);
        expect(
          evaluateCondition(cond, { ...base, hasMultipleVersions: false })
        ).toBe(false);
        expect(evaluateCondition(cond, base)).toBe(false);
      });

      it('hashes on hasMultipleVersions only', () => {
        const used = extractUsedContextFields(
          [preset?.templateData as never],
          [preset?.applicationCondition as never]
        );
        expect(used.has('hasMultipleVersions')).toBe(true);
        expect(used.has('versionCount')).toBe(false);
      });
    });
  }
});

describe('Returning Today presets', () => {
  const monitored = PRESET_TEMPLATES.find(
    (p) => p.name === 'Returning Today (Monitored)'
  );
  const unmonitored = PRESET_TEMPLATES.find(
    (p) => p.name === 'Returning Today (Unmonitored)'
  );
  // Yellowjackets on 23/11/2026 after the 13:00 S4E1 premiere: the next
  // episode pointer has moved to S4E2 and daysAgo counts from 2021.
  const premiereDay = {
    isPlaceholder: false,
    mediaType: 'show' as const,
    inSonarr: true,
    isMonitored: true,
    episodesAiringToday: 1,
    todaySeasonNumber: 4,
    todayEpisodeNumber: 1,
    seasonNumber: 4,
    episodeNumber: 2,
    daysAgo: 1835,
  };
  const shownField = (
    preset: typeof monitored,
    context: Record<string, unknown>
  ) => {
    const els = (preset?.templateData.elements ?? []).filter(
      (el) =>
        el.type === 'variable' &&
        evaluateCondition(el.condition, context as never)
    );
    expect(els).toHaveLength(1);
    const field = (
      els[0].properties as { segments: { type: string; field?: string }[] }
    ).segments.find((s) => s.type === 'variable')?.field;
    expect(field && context[field]).toBeDefined();
    return field;
  };

  it('matches a returning season all of premiere day, after airtime too', () => {
    expect(
      evaluateCondition(monitored?.applicationCondition, premiereDay)
    ).toBe(true);
    expect(shownField(monitored, premiereDay)).toBe('todaySeasonNumber');
    expect(
      evaluateCondition(unmonitored?.applicationCondition, premiereDay)
    ).toBe(false);
  });

  it('still has a season number after a whole season dropped at once', () => {
    const batch = {
      ...premiereDay,
      episodesAiringToday: 8,
      seasonNumber: undefined,
      episodeNumber: undefined,
    };
    expect(evaluateCondition(monitored?.applicationCondition, batch)).toBe(
      true
    );
    expect(shownField(monitored, batch)).toBe('todaySeasonNumber');
  });

  it('ignores ordinary episode days and brand-new shows', () => {
    for (const ctx of [
      { ...premiereDay, todayEpisodeNumber: 5 },
      { ...premiereDay, todaySeasonNumber: 1 },
      { ...premiereDay, episodesAiringToday: 0, todaySeasonNumber: undefined },
    ]) {
      expect(evaluateCondition(monitored?.applicationCondition, ctx)).toBe(
        false
      );
    }
  });

  it('matches an unmonitored Sonarr show on its premiere day', () => {
    const ctx = { ...premiereDay, isMonitored: false };
    expect(evaluateCondition(unmonitored?.applicationCondition, ctx)).toBe(
      true
    );
    expect(shownField(unmonitored, ctx)).toBe('todaySeasonNumber');
  });

  it('matches a show Sonarr does not have from its TMDB premiere date', () => {
    const ctx = {
      isPlaceholder: false,
      mediaType: 'show' as const,
      inSonarr: false,
      isMonitored: false,
      daysUntilNextSeason: 0,
      seasonNumber: 3,
      daysAgo: 1200,
    };
    expect(evaluateCondition(unmonitored?.applicationCondition, ctx)).toBe(
      true
    );
    expect(shownField(unmonitored, ctx)).toBe('seasonNumber');
    expect(evaluateCondition(monitored?.applicationCondition, ctx)).toBe(false);
  });
});

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

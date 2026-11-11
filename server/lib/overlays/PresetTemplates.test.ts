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

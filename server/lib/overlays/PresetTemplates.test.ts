import { extractUsedContextFields } from '@server/utils/metadataHashing';
import { describe, expect, it } from 'vitest';

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

  it('only applies when an audio profile was detected', () => {
    expect(preset?.applicationCondition?.sections?.[0]?.rules).toEqual([
      { field: 'audioProfile', operator: 'exists', value: true },
    ]);
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

  it('previews only for movies — the show path never sets audioProfile', () => {
    expect(createSampleOverlayContext('movie').audioProfile).toBe(
      'truehd_atmos'
    );
    expect(createSampleOverlayContext('show').audioProfile).toBeUndefined();
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

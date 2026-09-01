import { describe, expect, it } from 'vitest';

import { PRESET_TEMPLATES } from './PresetTemplates';

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
    expect(element.properties.mappings.length).toBeGreaterThan(0);
  });
});

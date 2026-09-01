import { describe, expect, it } from 'vitest';

import { getDefaultMappings } from './DefaultMappingsService';

describe('audioCodec default mappings', () => {
  const mappings = getDefaultMappings('audioCodec');
  const byValue = (value: string) => mappings.find((m) => m.value === value);

  it.each([
    ['ac3', 'digital'],
    ['eac3', 'plus'],
    ['dca-ma', 'ma'],
    ['dts', 'dca'],
  ])('maps Plex media codec %s to the %s icon', (value, icon) => {
    expect(byValue(value)?.iconPath).toBe(
      `/assets/mapped-icons/audio-codec/${icon}.png`
    );
  });

  it('keeps filename identity entries', () => {
    for (const value of ['truehd', 'aac', 'flac', 'ma', 'plus', 'digital']) {
      expect(byValue(value)?.iconPath).toBe(
        `/assets/mapped-icons/audio-codec/${value}.png`
      );
    }
  });

  it('has no duplicate values', () => {
    const values = mappings.map((m) => m.value);
    expect(new Set(values).size).toBe(values.length);
  });
});

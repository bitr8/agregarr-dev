import { describe, expect, it } from 'vitest';
import {
  createTemplateLogoPlaceholder,
  getEstimatedTextWidth,
} from './posterGeneration';

describe('posterGeneration input guards', () => {
  it('caps the width estimation loop', () => {
    expect(getEstimatedTextWidth('a'.repeat(1_000_000), 10)).toBe(
      getEstimatedTextWidth('a'.repeat(1000), 10)
    );
    expect(getEstimatedTextWidth('abc', 10)).toBeGreaterThan(0);
  });

  it('tolerates non-string service type', () => {
    const bad = ['plex'] as unknown as string;
    expect(() =>
      createTemplateLogoPlaceholder(bad, 0, 0, 60, 60)
    ).not.toThrow();
    expect(createTemplateLogoPlaceholder('plex', 0, 0, 60, 60)).toContain(
      'Plex'
    );
  });
});

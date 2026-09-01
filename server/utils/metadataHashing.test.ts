import { describe, expect, it } from 'vitest';
import { calculateOverlayInputHash } from './metadataHashing';

describe('overlay input hashing', () => {
  it('regenerates artwork when output quality changes', () => {
    const base = {
      templateIds: [],
      templateData: [],
      usedFields: new Set<string>(),
      context: {},
    };

    const quality95 = calculateOverlayInputHash({
      ...base,
      renderOptions: { format: 'jpeg', jpegQuality: 95 },
    });
    const quality100 = calculateOverlayInputHash({
      ...base,
      renderOptions: { format: 'jpeg', jpegQuality: 100 },
    });

    expect(quality95).not.toBe(quality100);
  });
});

import { describe, expect, it } from 'vitest';

import { createSampleOverlayContext } from './sampleOverlayContext';

describe('sample overlay context', () => {
  it('does not provide variables the real render never sets', () => {
    for (const mediaType of ['movie', 'show'] as const) {
      expect(
        createSampleOverlayContext(mediaType).episodeLabel
      ).toBeUndefined();
    }
  });

  it('still provides the episode number', () => {
    expect(createSampleOverlayContext('show').episodeNumber).toBe(5);
  });
});

import { describe, expect, it } from 'vitest';

import { shouldSkipEmptyRenderUpload } from './emptyRenderUploadPolicy';

describe('shouldSkipEmptyRenderUpload', () => {
  it('skips when nothing rendered and the item was never overlaid by us', () => {
    expect(shouldSkipEmptyRenderUpload(0, false)).toBe(true);
  });

  it('does not skip when nothing rendered but the current poster is ours (removal)', () => {
    expect(shouldSkipEmptyRenderUpload(0, true)).toBe(false);
  });

  it('does not skip when overlays rendered, regardless of poster ownership', () => {
    expect(shouldSkipEmptyRenderUpload(2, false)).toBe(false);
    expect(shouldSkipEmptyRenderUpload(1, true)).toBe(false);
  });
});

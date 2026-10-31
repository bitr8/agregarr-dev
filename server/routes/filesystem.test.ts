import { describe, expect, it } from 'vitest';
import { isDeniedBrowsePath } from './filesystem';

describe('isDeniedBrowsePath', () => {
  it('denies sensitive roots and children', () => {
    expect(isDeniedBrowsePath('/proc')).toBe(true);
    expect(isDeniedBrowsePath('/proc/1/root')).toBe(true);
    expect(isDeniedBrowsePath('/app/node_modules/x')).toBe(true);
  });

  it('allows media paths', () => {
    expect(isDeniedBrowsePath('/mnt/user/media')).toBe(false);
    expect(isDeniedBrowsePath('/processing')).toBe(false);
  });
});

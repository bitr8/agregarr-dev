import { plexVersionAtLeast } from '@server/lib/plexVersion';
import { describe, expect, it } from 'vitest';

describe('plexVersionAtLeast', () => {
  it('compares real PMS version strings', () => {
    expect(plexVersionAtLeast('1.43.4.10196-3a59ad1b1', '1.43.3')).toBe(true);
    expect(plexVersionAtLeast('1.43.3.9999-abc', '1.43.3')).toBe(true);
    expect(plexVersionAtLeast('1.43.2.10162-0a6f2d7a9', '1.43.3')).toBe(false);
    expect(plexVersionAtLeast('1.42.9.1', '1.43.3')).toBe(false);
    expect(plexVersionAtLeast('1.100.0.1', '1.43.3')).toBe(true);
    expect(plexVersionAtLeast('2.0.0.1', '1.43.3')).toBe(true);
    expect(plexVersionAtLeast('1.43.3.10860-abc', '1.43.3.10861')).toBe(false);
    expect(plexVersionAtLeast('1.43.3.10861-abc', '1.43.3.10861')).toBe(true);
    expect(plexVersionAtLeast('1.43.10.1', '1.43.3.10861')).toBe(true);
    expect(plexVersionAtLeast('1.44.0', '1.43.3.10861')).toBe(true);
  });

  it('treats unknown or garbage versions as not at least', () => {
    expect(plexVersionAtLeast(undefined, '1.43.3')).toBe(false);
    expect(plexVersionAtLeast('', '1.43.3')).toBe(false);
    expect(plexVersionAtLeast('beta', '1.43.3')).toBe(false);
    expect(plexVersionAtLeast('2.bad', '1.43.3')).toBe(false);
    expect(plexVersionAtLeast('1.44.bad', '1.43.3')).toBe(false);
    expect(plexVersionAtLeast('1.43', '1.43.3')).toBe(false);
    expect(plexVersionAtLeast('1.44.', '1.43.3')).toBe(false);
    expect(plexVersionAtLeast('1.44.0x10', '1.43.3')).toBe(false);
    expect(plexVersionAtLeast('1.44.1e2', '1.43.3')).toBe(false);
  });
});

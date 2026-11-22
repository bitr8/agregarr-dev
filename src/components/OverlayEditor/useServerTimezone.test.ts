import { describe, expect, it } from 'vitest';
import { resolveServerTimezone } from './useServerTimezone';

describe('resolveServerTimezone', () => {
  it('passes a valid IANA zone through', () => {
    expect(resolveServerTimezone('Australia/Sydney')).toBe('Australia/Sydney');
  });

  it('falls back to UTC when missing or unusable', () => {
    expect(resolveServerTimezone(undefined)).toBe('UTC');
    expect(resolveServerTimezone('')).toBe('UTC');
    expect(resolveServerTimezone('Not/AZone')).toBe('UTC');
    expect(resolveServerTimezone('AEST-10')).toBe('UTC');
  });
});

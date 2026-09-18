import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = new Date('2026-09-17T00:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

import { daysSince } from './OverlayContextBuilder';

describe('daysSince', () => {
  it('returns days elapsed since a unix-seconds timestamp', () => {
    const threeDaysAgo = NOW.getTime() / 1000 - 3 * 24 * 60 * 60;
    expect(daysSince(threeDaysAgo)).toBe(3);
  });

  it('returns undefined when the timestamp is absent', () => {
    expect(daysSince(undefined)).toBeUndefined();
  });
});

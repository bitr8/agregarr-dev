import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './mapWithConcurrency';

describe('mapWithConcurrency', () => {
  it('processes every value without exceeding the configured limit', async () => {
    let active = 0;
    let maximumActive = 0;
    const processed: number[] = [];

    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      processed.push(value);
      active--;
    });

    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(processed.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('rejects invalid concurrency limits', async () => {
    await expect(
      mapWithConcurrency([1], 0, async () => undefined)
    ).rejects.toThrow('positive integer');
  });
});

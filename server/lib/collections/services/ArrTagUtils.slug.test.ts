import { describe, expect, it } from 'vitest';
import { slugifyTagSegment } from './ArrTagUtils';

describe('slugifyTagSegment', () => {
  it('slugifies normal labels', () => {
    expect(slugifyTagSegment(' Top Rated! ')).toBe('top-rated');
  });

  it('bounds pathological input', () => {
    expect(
      slugifyTagSegment('-'.repeat(100000) + 'a').length
    ).toBeLessThanOrEqual(200);
  });
});

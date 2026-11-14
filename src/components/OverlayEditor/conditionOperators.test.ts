import { describe, expect, it } from 'vitest';

import { isOperatorInvalidForField } from './conditionOperators';

const kind = (
  over: Partial<Parameters<typeof isOperatorInvalidForField>[1]>
) => ({
  isNumeric: false,
  isBoolean: false,
  isCollection: false,
  isPlexLabels: false,
  ...over,
});

describe('operators offered for yes/no fields', () => {
  it('accepts only equals and not equals', () => {
    const k = kind({ isBoolean: true });
    expect(isOperatorInvalidForField('eq', k)).toBe(false);
    expect(isOperatorInvalidForField('neq', k)).toBe(false);
    expect(isOperatorInvalidForField('exists', k)).toBe(true);
    expect(isOperatorInvalidForField('contains', k)).toBe(true);
  });

  it('still allows exists on other field types', () => {
    expect(isOperatorInvalidForField('exists', kind({}))).toBe(false);
    expect(isOperatorInvalidForField('gt', kind({ isNumeric: true }))).toBe(
      false
    );
    expect(isOperatorInvalidForField('gt', kind({}))).toBe(true);
  });
});

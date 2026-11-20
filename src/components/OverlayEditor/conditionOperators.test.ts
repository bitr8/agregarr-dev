import { describe, expect, it } from 'vitest';

import type { ConditionRule } from '@server/entity/OverlayTemplate';
import {
  coerceValueForOperator,
  isOperatorInvalidForField,
  isOperatorOfferedForField,
  reorderRules,
} from './conditionOperators';

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

describe('operators offered for numeric fields', () => {
  const k = kind({ isNumeric: true });
  it('drops text-only operators and keeps the rest', () => {
    for (const op of ['contains', 'notContains', 'regex', 'begins', 'ends']) {
      expect(isOperatorOfferedForField(op, k)).toBe(false);
    }
    for (const op of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'exists']) {
      expect(isOperatorOfferedForField(op, k)).toBe(true);
    }
  });

  it('keeps text operators on text fields', () => {
    expect(isOperatorOfferedForField('regex', kind({}))).toBe(true);
  });
});

describe('value coercion when the operator changes', () => {
  const num = { isNumeric: true, isBoolean: false };
  it('turns saved text into a number for comparisons', () => {
    expect(coerceValueForOperator('in', 'gt', '5', num)).toBe(5);
    expect(coerceValueForOperator('in', 'gt', '5, 6', num)).toBe('');
  });
  it('turns a number into text for in', () => {
    expect(coerceValueForOperator('eq', 'in', 5, num)).toBe('5');
  });
  it('sets true for exists and clears it on the way out', () => {
    expect(coerceValueForOperator('eq', 'exists', 'x', num)).toBe(true);
    expect(coerceValueForOperator('exists', 'eq', true, num)).toBe('');
    expect(
      coerceValueForOperator('exists', 'eq', true, {
        isNumeric: false,
        isBoolean: true,
      })
    ).toBe(true);
    expect(
      coerceValueForOperator('exists', 'contains', true, {
        isNumeric: false,
        isBoolean: false,
      })
    ).toBe('');
  });
  it('leaves text values alone', () => {
    expect(
      coerceValueForOperator('eq', 'contains', 'abc', {
        isNumeric: false,
        isBoolean: false,
      })
    ).toBe('abc');
  });
});

describe('reordering rules keeps connectors in their slots', () => {
  const r = (field: string, ruleOperator?: 'and' | 'or'): ConditionRule => ({
    field,
    operator: 'eq',
    value: 1,
    ...(ruleOperator ? { ruleOperator } : {}),
  });
  it('A AND B OR C, third dragged to the top', () => {
    const out = reorderRules([r('A'), r('B', 'and'), r('C', 'or')], 2, 0);
    expect(out.map((x) => x.field)).toEqual(['C', 'A', 'B']);
    expect(out.map((x) => x.ruleOperator)).toEqual([undefined, 'and', 'or']);
  });
  it('first rule dragged down', () => {
    const out = reorderRules([r('A'), r('B', 'or'), r('C', 'and')], 0, 2);
    expect(out.map((x) => x.field)).toEqual(['B', 'C', 'A']);
    expect(out.map((x) => x.ruleOperator)).toEqual([undefined, 'or', 'and']);
  });
});

import { describe, expect, it } from 'vitest';

import type { ApplicationCondition } from '@app/components/OverlayEditor/types';

import { evaluateCondition } from './conditionEvaluator';

const inRule = (value: unknown): ApplicationCondition =>
  ({
    sections: [
      {
        sectionOperator: 'and',
        rules: [{ field: 'resolution', operator: 'in', value }],
      },
    ],
  } as ApplicationCondition);

describe("preview 'in' operator", () => {
  it('matches comma-separated text and lists like the server', () => {
    expect(evaluateCondition(inRule('4k, 2160'), { resolution: '2160' })).toBe(
      true
    );
    expect(evaluateCondition(inRule(['4K']), { resolution: '4k' })).toBe(true);
  });

  it('compares list values with the same types as the server', () => {
    const yearIn = (value: unknown): ApplicationCondition =>
      ({
        sections: [
          {
            sectionOperator: 'and',
            rules: [{ field: 'year', operator: 'in', value }],
          },
        ],
      } as ApplicationCondition);
    expect(evaluateCondition(yearIn([2024]), { year: 2024 })).toBe(true);
    expect(evaluateCondition(yearIn(['2024']), { year: 2024 })).toBe(false);
    expect(evaluateCondition(yearIn([true]), { year: true })).toBe(true);
  });

  it('hides the element when the value is not in the list', () => {
    expect(evaluateCondition(inRule('4k,2160'), { resolution: '1080' })).toBe(
      false
    );
    expect(evaluateCondition(inRule('4k'), { resolution: ['4k'] })).toBe(false);
  });
});

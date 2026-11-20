import type { ApplicationCondition } from '@server/entity/OverlayTemplate';
import { describe, expect, it } from 'vitest';
import { evaluateCondition, hasEffectiveCondition } from './conditionEvaluator';

const rule = (
  field: string,
  operator: string,
  value: unknown
): ApplicationCondition =>
  ({
    sections: [{ rules: [{ field, operator, value }] }],
  } as ApplicationCondition);

describe('list fields match on any item for in, regex, begins and ends', () => {
  const ctx = { radarrTags: ['4k', 'anime'] };

  it('in', () => {
    expect(evaluateCondition(rule('radarrTags', 'in', 'x, 4K'), ctx)).toBe(
      true
    );
    expect(evaluateCondition(rule('radarrTags', 'in', 'x, y'), ctx)).toBe(
      false
    );
  });

  it('regex', () => {
    expect(evaluateCondition(rule('radarrTags', 'regex', '^4k$'), ctx)).toBe(
      true
    );
    expect(evaluateCondition(rule('radarrTags', 'regex', '^hd$'), ctx)).toBe(
      false
    );
    expect(evaluateCondition(rule('radarrTags', 'regex', '('), ctx)).toBe(
      false
    );
  });

  it('begins and ends', () => {
    expect(evaluateCondition(rule('radarrTags', 'begins', 'an'), ctx)).toBe(
      true
    );
    expect(evaluateCondition(rule('radarrTags', 'ends', 'ime'), ctx)).toBe(
      true
    );
    expect(evaluateCondition(rule('radarrTags', 'begins', 'zz'), ctx)).toBe(
      false
    );
  });

  it('empty list never matches', () => {
    expect(
      evaluateCondition(rule('radarrTags', 'in', '4k'), { radarrTags: [] })
    ).toBe(false);
  });
});

describe('existing behaviour is unchanged', () => {
  it('scalar text operators', () => {
    expect(
      evaluateCondition(rule('title', 'regex', 'MATR'), { title: 'The Matrix' })
    ).toBe(true);
    expect(
      evaluateCondition(rule('title', 'begins', 'the'), { title: 'The Matrix' })
    ).toBe(true);
    expect(
      evaluateCondition(rule('title', 'ends', 'x'), { title: 'The Matrix' })
    ).toBe(true);
    expect(
      evaluateCondition(rule('title', 'in', 'a, the matrix'), {
        title: 'The Matrix',
      })
    ).toBe(true);
  });

  it('numeric in matches as text', () => {
    expect(
      evaluateCondition(rule('totalSeasons', 'in', '5'), { totalSeasons: 5 })
    ).toBe(true);
    expect(
      evaluateCondition(rule('totalSeasons', 'eq', '5'), { totalSeasons: 5 })
    ).toBe(false);
  });

  it('text operators on numbers never match', () => {
    expect(
      evaluateCondition(rule('imdbRating', 'regex', '7'), { imdbRating: 7 })
    ).toBe(false);
    expect(
      evaluateCondition(rule('imdbRating', 'begins', '7'), { imdbRating: 7 })
    ).toBe(false);
  });

  it('Date fields only match exists', () => {
    const ctx = { dateAdded: new Date('2024-01-01') };
    expect(evaluateCondition(rule('dateAdded', 'eq', '2024-01-01'), ctx)).toBe(
      false
    );
    expect(evaluateCondition(rule('dateAdded', 'begins', '2024'), ctx)).toBe(
      false
    );
    expect(evaluateCondition(rule('dateAdded', 'in', '2024-01-01'), ctx)).toBe(
      false
    );
    expect(evaluateCondition(rule('dateAdded', 'exists', true), ctx)).toBe(
      true
    );
  });

  it('absent fields and connectors', () => {
    expect(evaluateCondition(rule('year', 'gt', 1), {})).toBe(false);
    expect(evaluateCondition(rule('year', 'neq', 1), {})).toBe(true);
    const cond = {
      sections: [
        {
          rules: [
            { field: 'a', operator: 'eq', value: 1 },
            { field: 'b', operator: 'eq', value: 1, ruleOperator: 'and' },
            { field: 'c', operator: 'eq', value: 1, ruleOperator: 'or' },
          ],
        },
      ],
    } as ApplicationCondition;
    expect(evaluateCondition(cond, { a: 1, b: 2, c: 1 })).toBe(true);
    expect(evaluateCondition(cond, { a: 1, b: 2, c: 2 })).toBe(false);
  });
});

describe('hasEffectiveCondition', () => {
  it('is true only when a section holds at least one rule', () => {
    expect(hasEffectiveCondition(rule('a', 'eq', 1))).toBe(true);
    expect(hasEffectiveCondition(undefined)).toBe(false);
    expect(hasEffectiveCondition(null)).toBe(false);
    expect(hasEffectiveCondition({ sections: [] })).toBe(false);
    expect(hasEffectiveCondition({ sections: [{ rules: [] }] } as never)).toBe(
      false
    );
  });

  it('leaves evaluation alone: an emptied condition still always matches', () => {
    expect(evaluateCondition({ sections: [{ rules: [] }] } as never, {})).toBe(
      true
    );
  });
});

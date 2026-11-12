import { describe, expect, it } from 'vitest';

import type { ApplicationCondition } from '@server/entity/OverlayTemplate';

import type { OverlayRenderContext } from './OverlayTemplateRenderer';
import { evaluateCondition } from './OverlayTemplateRenderer';

const inRule = (field: string, value: unknown): ApplicationCondition => ({
  sections: [
    {
      sectionOperator: 'and',
      rules: [
        {
          field,
          operator: 'in',
          value,
        } as ApplicationCondition['sections'][number]['rules'][number],
      ],
    },
  ],
});

const ctx = (over: Partial<OverlayRenderContext>): OverlayRenderContext =>
  over as OverlayRenderContext;

describe("'in' operator", () => {
  it('matches comma-separated text saved by the condition editor', () => {
    expect(
      evaluateCondition(
        inRule('resolution', '4k,2160'),
        ctx({ resolution: '4k' })
      )
    ).toBe(true);
    expect(
      evaluateCondition(
        inRule('resolution', '4k, 2160'),
        ctx({ resolution: '2160' })
      )
    ).toBe(true);
  });

  it('matches a single-value text rule', () => {
    expect(
      evaluateCondition(inRule('resolution', '4K'), ctx({ resolution: '4k' }))
    ).toBe(true);
  });

  it('does not match a value outside the list', () => {
    expect(
      evaluateCondition(
        inRule('resolution', '4k,2160'),
        ctx({ resolution: '1080' })
      )
    ).toBe(false);
    expect(
      evaluateCondition(inRule('resolution', '4k,'), ctx({ resolution: '' }))
    ).toBe(false);
  });

  it('matches numeric fields against text values', () => {
    expect(
      evaluateCondition(inRule('year', '2023,2024'), ctx({ year: 2024 }))
    ).toBe(true);
  });

  it('matches a single number saved by the numeric input', () => {
    expect(evaluateCondition(inRule('year', 2024), ctx({ year: 2024 }))).toBe(
      true
    );
    expect(evaluateCondition(inRule('year', 2024), ctx({ year: 2023 }))).toBe(
      false
    );
  });

  it('still matches array values from preset templates', () => {
    expect(
      evaluateCondition(
        inRule('resolution', ['4k', '2160']),
        ctx({ resolution: '4K' })
      )
    ).toBe(true);
    expect(
      evaluateCondition(
        inRule('resolution', ['4k', '2160']),
        ctx({ resolution: '1080' })
      )
    ).toBe(false);
  });

  it('does not coerce list-valued fields into a match', () => {
    expect(
      evaluateCondition(
        inRule('audioLanguages', 'english'),
        ctx({ audioLanguages: ['English'] } as Partial<OverlayRenderContext>)
      )
    ).toBe(false);
  });

  it('does not match a missing field', () => {
    expect(evaluateCondition(inRule('resolution', '4k'), ctx({}))).toBe(false);
  });
});

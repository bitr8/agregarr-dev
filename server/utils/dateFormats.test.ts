import { buildVariableDisplayText } from '@app/components/OverlayEditor/variableDisplayText';
import { describe, expect, it } from 'vitest';
import { DATE_FORMATS, formatDateInTimezone } from './dateFormats';
import { formatDate } from './dateHelpers';

const SAMPLE = '2026-12-03';

describe('date format table', () => {
  it('has unique values', () => {
    const values = DATE_FORMATS.map((f) => f.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('renders every dropdown value, not the MMM DD fallback', () => {
    for (const f of DATE_FORMATS) {
      if (f.value === 'MMM DD') continue;
      expect(formatDateInTimezone(SAMPLE, f.value, 'UTC'), f.value).not.toBe(
        'DEC 03'
      );
    }
  });

  it('adds month-and-year formats', () => {
    expect(formatDateInTimezone(SAMPLE, 'MMM YYYY', 'UTC')).toBe('DEC 2026');
    expect(formatDateInTimezone(SAMPLE, 'MMMM YYYY', 'UTC')).toBe(
      'December 2026'
    );
  });

  it('gives identical output from server and editor for every format', () => {
    process.env.TZ = 'Australia/Sydney';
    for (const f of DATE_FORMATS) {
      for (const v of [SAMPLE, '2026-11-20T14:30:00Z']) {
        const editor = buildVariableDisplayText(
          {
            segments: [
              { type: 'variable', field: 'releaseDate', format: f.value },
            ],
          } as never,
          { releaseDate: v } as never,
          'Australia/Sydney'
        );
        expect(editor, `${f.value} ${v}`).toBe(formatDate(v, f.value));
      }
    }
  });

  it('formats a Date in the given timezone', () => {
    const d = new Date('2026-11-20T14:30:00Z');
    expect(formatDateInTimezone(d, 'YYYY-MM-DD', 'Australia/Sydney')).toBe(
      '2026-11-21'
    );
    expect(formatDateInTimezone(d, 'YYYY-MM-DD', 'UTC')).toBe('2026-11-20');
  });
});

describe('bare dates are calendar dates in every timezone', () => {
  const zones = [
    'Pacific/Auckland',
    'Pacific/Kiritimati',
    'Australia/Sydney',
    'America/Los_Angeles',
    'UTC',
  ];
  for (const tz of zones) {
    it(`formatDate ${tz}`, () => {
      process.env.TZ = tz;
      expect(formatDate(SAMPLE, 'MMM DD')).toBe('DEC 03');
    });
  }
});

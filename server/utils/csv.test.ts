import { describe, expect, it } from 'vitest';
import { csvCell } from './csv';

describe('spreadsheet-safe CSV cells', () => {
  it.each(['=1+1', '+SUM(1,1)', '-2+3', '@command'])(
    'neutralizes the formula prefix in %s',
    (value) => {
      expect(csvCell(value).startsWith(`"'`)).toBe(true);
    }
  );

  it('preserves ordinary values while escaping quotes', () => {
    expect(csvCell('A "quoted" value')).toBe('"A ""quoted"" value"');
  });
});

import { DATE_FORMATS } from '@server/utils/dateFormats';
import { formatDate } from '@server/utils/dateHelpers';
import { describe, expect, it } from 'vitest';
import { buildVariableDisplayText } from './variableDisplayText';

describe('editor and server date formatting', () => {
  it('gives identical output from server and editor for every format', () => {
    process.env.TZ = 'Australia/Sydney';
    for (const f of DATE_FORMATS) {
      for (const v of ['2026-12-03', '2026-11-20T14:30:00Z']) {
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
});

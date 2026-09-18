import { describe, expect, it } from 'vitest';
import { serializeOverlayOutcomeCsv } from './overlayOutcomeCsv';

describe('overlay outcome CSV', () => {
  it('exports every library and safely quotes paths, titles, and errors', () => {
    const csv = serializeOverlayOutcomeCsv([
      {
        libraryId: '2',
        libraryName: 'TV Shows',
        omittedItems: 12,
        items: [
          {
            processedAt: Date.UTC(2026, 7, 24, 9, 30),
            outcome: 'error',
            target: 'episode',
            title: 'Show, S01E01 - "Pilot"',
            filePath: '/tv/Show/Season 01/Pilot.mkv',
            ratingKey: '123',
            message: 'Plex said "no"',
          },
        ],
      },
    ]);

    expect(csv).toContain('"2026-08-24T09:30:00.000Z","TV Shows"');
    expect(csv).toContain('"Show, S01E01 - ""Pilot"""');
    expect(csv).toContain('"Plex said ""no"""');
    expect(csv).toContain('"12"');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('returns a header-only log before any items have completed', () => {
    expect(serializeOverlayOutcomeCsv([]).split('\r\n')).toHaveLength(2);
  });

  it('neutralizes spreadsheet formulas in exported values', () => {
    const csv = serializeOverlayOutcomeCsv([
      {
        libraryId: '1',
        libraryName: '@Movies',
        omittedItems: 0,
        items: [],
      },
      {
        libraryId: '2',
        libraryName: 'TV',
        omittedItems: 0,
        items: [
          {
            processedAt: 0,
            outcome: 'success',
            target: 'main',
            title: '+SUM(1,1)',
            ratingKey: '1',
          },
        ],
      },
    ]);

    expect(csv).toContain(`"'+SUM(1,1)"`);
  });
});

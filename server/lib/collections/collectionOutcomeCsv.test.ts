import { serializeCollectionOutcomeCsv } from './collectionOutcomeCsv';
import type { CollectionOutcome } from './CollectionSyncProgress';

import { describe, expect, it } from 'vitest';

describe('collection outcome CSV', () => {
  it('exports collection results and safely quotes names and errors', () => {
    const outcome: CollectionOutcome = {
      configId: 'config-1',
      name: 'Popular, "Today"',
      sourceType: 'trakt',
      outcome: 'error',
      created: 1,
      updated: 2,
      errorMessage: 'Plex said "no"',
      durationMs: 1250,
      processedAt: Date.UTC(2026, 7, 24, 9, 30),
    };

    const csv = serializeCollectionOutcomeCsv([outcome]);

    expect(csv).toContain('"2026-08-24T09:30:00.000Z","error"');
    expect(csv).toContain('"Popular, ""Today"""');
    expect(csv).toContain('"Plex said ""no"""');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('returns a header-only log before any collections have completed', () => {
    expect(serializeCollectionOutcomeCsv([]).split('\r\n')).toHaveLength(2);
  });
});

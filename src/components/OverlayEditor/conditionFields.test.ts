import { describe, expect, it } from 'vitest';
import { BOOLEAN_FIELDS, NUMERIC_FIELDS } from './conditionFields';
import { CONDITION_FIELD_CATEGORIES } from './types';

const offered = Object.values(CONDITION_FIELD_CATEGORIES)
  .flat()
  .map((f) => f.field);

describe('condition field kinds', () => {
  it('classes the numeric and yes/no fields that were saved as text', () => {
    for (const f of ['totalSeasons', 'episode4kPercent', 'showBitDepth']) {
      expect(NUMERIC_FIELDS.has(f)).toBe(true);
    }
    for (const f of ['showHdr', 'showDolbyVision']) {
      expect(BOOLEAN_FIELDS.has(f)).toBe(true);
    }
  });

  it('no field is both numeric and yes/no', () => {
    for (const f of NUMERIC_FIELDS) expect(BOOLEAN_FIELDS.has(f)).toBe(false);
  });

  it('does not offer the Date fields', () => {
    for (const f of ['lastPlayed', 'dateAdded', 'lastEpisodeAddedDate']) {
      expect(offered).not.toContain(f);
    }
    expect(offered).toContain('daysSinceAdded');
  });
});

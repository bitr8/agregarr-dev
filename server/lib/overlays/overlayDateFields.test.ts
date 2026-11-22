import { describe, expect, it } from 'vitest';
import { isOverlayDateField, OVERLAY_DATE_FIELDS } from './overlayDateFields';

describe('overlay date fields', () => {
  it('includes the next episode and next season dates', () => {
    expect(isOverlayDateField('nextEpisodeAirDate')).toBe(true);
    expect(isOverlayDateField('nextSeasonAirDate')).toBe(true);
    expect(isOverlayDateField('lastAiredEpisodeDate')).toBe(true);
    expect(isOverlayDateField('nextFinaleDate')).toBe(true);
    expect(isOverlayDateField('lastFinaleDate')).toBe(true);
  });

  it('lists the twelve fields the format dropdown is offered on', () => {
    expect(OVERLAY_DATE_FIELDS).toHaveLength(12);
  });

  it('rejects other fields', () => {
    expect(isOverlayDateField('imdbRating')).toBe(false);
    expect(isOverlayDateField(undefined)).toBe(false);
  });
});

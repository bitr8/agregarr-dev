import { describe, expect, it } from 'vitest';
import {
  formatNumberSegment,
  isOverlayNumberFormatField,
  mergeSegmentUpdate,
  NUMBER_FORMATS,
  NUMBER_FORMAT_FIELDS,
} from './numberFormats';

describe('number format table', () => {
  it('has unique values and a plain entry', () => {
    const values = NUMBER_FORMATS.map((f) => f.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain('');
  });

  it('has a formatter case for every dropdown value', () => {
    for (const f of NUMBER_FORMATS) {
      expect(typeof f.format(7), f.value).toBe('string');
    }
    expect(formatNumberSegment(7, 'pad2', 'episodeNumber')).toBe('07');
    expect(formatNumberSegment(7, 'pad3', 'episodeNumber')).toBe('007');
  });
});

describe('formatNumberSegment', () => {
  it('pads integers', () => {
    expect(formatNumberSegment(5, 'pad2', 'episodeNumber')).toBe('05');
    expect(formatNumberSegment(5, 'pad3', 'episodeNumber')).toBe('005');
    expect(formatNumberSegment(0, 'pad2', 'episodeNumber')).toBe('00');
  });

  it('prints values already wider than the pad as-is', () => {
    expect(formatNumberSegment(123, 'pad2', 'episodeNumber')).toBe('123');
  });

  it('renders exactly as today when format is absent or unknown', () => {
    for (const f of [undefined, '', 'MMM DD', 'YYYY-MM-DD', 'pad9']) {
      expect(formatNumberSegment(5, f, 'episodeNumber')).toBe('5');
      expect(formatNumberSegment(1234, f, 'episodeNumber')).toBe('1234');
    }
  });

  it('does not pad negatives or non-integers', () => {
    expect(formatNumberSegment(-5, 'pad2', 'episodeNumber')).toBe('-5');
    expect(formatNumberSegment(8.7, 'pad2', 'episodeNumber')).toBe('8.7');
  });
});

describe('number format allowlist', () => {
  it('offers padding on the chosen integer fields', () => {
    for (const f of [
      'seasonNumber',
      'episodeNumber',
      'totalSeasons',
      'seasonsAvailable',
      'missingEpisodeCount',
      'daysAgo',
      'daysUntilRelease',
      'daysUntilNextEpisode',
      'daysUntilNextSeason',
      'daysSinceAdded',
      'viewCount',
      'imdbTop250Rank',
    ]) {
      expect(isOverlayNumberFormatField(f), f).toBe(true);
      expect(NUMBER_FORMAT_FIELDS).toContain(f);
    }
  });

  it('refuses years, ratings, percentages, sizes, resolution, dates, ranks in collections and unknowns', () => {
    for (const f of [
      undefined,
      'year',
      'plexUserRating',
      'imdbRating',
      'rtCriticsScore',
      'episode4kPercent',
      'episodeHdPercent',
      'episodeSdPercent',
      'fileSize',
      'width',
      'showResolution',
      'releaseDate',
      'daysSincePhysicalRelease',
      'daysSinceTheatricalRelease',
      'daysSinceDigitalRelease',
      'daysSinceHomeRelease',
      'daysAgoNextSeason',
      'daysUntilAction',
      'collectionRank',
      'title',
    ]) {
      expect(isOverlayNumberFormatField(f), String(f)).toBe(false);
    }
  });

  it('never pads a field outside the allowlist, even with a stale format', () => {
    expect(formatNumberSegment(8, 'pad2', 'plexUserRating')).toBe('8');
    expect(formatNumberSegment(88, 'pad3', 'rtCriticsScore')).toBe('88');
    expect(formatNumberSegment(1999, 'pad3', 'year')).toBe('1999');
    expect(formatNumberSegment(8, 'pad2', undefined)).toBe('8');
  });

  it('only keeps a format that is valid for the new field', () => {
    const seg = (field: string, format?: string) => ({
      type: 'variable',
      field,
      format,
    });
    expect(
      mergeSegmentUpdate(seg('releaseDate', 'MMM DD'), {
        field: 'seasonNumber',
      }).format
    ).toBeUndefined();
    expect(
      mergeSegmentUpdate(seg('seasonNumber', 'pad2'), { field: 'releaseDate' })
        .format
    ).toBeUndefined();
    expect(
      mergeSegmentUpdate(seg('seasonNumber', 'pad2'), {
        field: 'episodeNumber',
      }).format
    ).toBe('pad2');
    expect(
      mergeSegmentUpdate(seg('releaseDate', 'MMM DD'), { field: 'dateAdded' })
        .format
    ).toBe('MMM DD');
    expect(
      mergeSegmentUpdate(seg('seasonNumber', 'bogus'), {
        field: 'episodeNumber',
      }).format
    ).toBeUndefined();
    expect(
      mergeSegmentUpdate(seg('seasonNumber', 'pad2'), {
        field: 'plexUserRating',
      }).format
    ).toBeUndefined();
  });

  it('applies non-field updates as given', () => {
    const merged = mergeSegmentUpdate(
      { type: 'variable', field: 'seasonNumber', format: 'pad2' },
      { format: 'pad3' }
    );
    expect(merged).toEqual({
      type: 'variable',
      field: 'seasonNumber',
      format: 'pad3',
    });
  });
});

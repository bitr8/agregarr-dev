import { describe, expect, it } from 'vitest';
import { selectMappedIcons } from './mappedIconSelection';

const mappings = [
  { value: 'Extended', iconPath: '/e.png' },
  { value: 'IMAX', iconPath: '/i.png' },
  { value: 'Unrated', iconPath: '/u.png' },
];

describe('selectMappedIcons', () => {
  it('returns matched icons case-insensitively', () => {
    expect(selectMappedIcons(mappings, 'imax', undefined, true)).toEqual({
      mappings: [mappings[1]],
    });
  });

  it('shows the first mapping flagged as unmatched when nothing matches', () => {
    expect(
      selectMappedIcons(mappings, 'Extended Cut', undefined, true)
    ).toEqual({ mappings: [mappings[0]], unmatchedValue: 'Extended Cut' });
  });

  it('does not flag a partial match on an array field', () => {
    expect(
      selectMappedIcons(mappings, ['IMAX', 'Nope'], undefined, false)
    ).toEqual({ mappings: [mappings[1]] });
  });

  it('keeps the undefined-field fallback unchanged', () => {
    expect(selectMappedIcons(mappings, undefined, undefined, true)).toEqual({
      mappings: [mappings[0]],
    });
    expect(selectMappedIcons(mappings, undefined, 2, false)).toEqual({
      mappings: mappings.slice(0, 2),
    });
  });

  it('shows nothing with no mappings', () => {
    expect(selectMappedIcons([], 'x', undefined, true)).toEqual({
      mappings: [],
    });
  });
});

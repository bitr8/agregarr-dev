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

describe('selectMappedIcons fallback mappings', () => {
  const fallback = [
    { value: '4K', iconPath: '/f4k.png' },
    { value: 'IMAX', iconPath: '/fimax.png' },
  ];

  it('previews an icon for a value the element list misses', () => {
    expect(
      selectMappedIcons(mappings, '4k', undefined, true, fallback)
    ).toEqual({ mappings: [fallback[0]] });
  });

  it('prefers the element mapping over the fallback', () => {
    expect(
      selectMappedIcons(mappings, 'IMAX', undefined, true, fallback)
    ).toEqual({ mappings: [mappings[1]] });
  });

  it('previews icons for an element with an empty list', () => {
    expect(selectMappedIcons([], '4K', undefined, true, fallback)).toEqual({
      mappings: [fallback[0]],
    });
    expect(selectMappedIcons([], undefined, undefined, true, fallback)).toEqual(
      { mappings: [fallback[0]] }
    );
  });

  it('still flags a value neither list covers', () => {
    expect(
      selectMappedIcons(mappings, 'nope', undefined, true, fallback)
    ).toEqual({ mappings: [mappings[0]], unmatchedValue: 'nope' });
  });
});

import { describe, expect, it } from 'vitest';
import {
  normaliseSingleLine,
  singleLineAnchorX,
  singleLineFont,
} from './singleLineText';

describe('single line text helpers', () => {
  it('anchors by alignment like the server SVG text', () => {
    expect(singleLineAnchorX('left', 100)).toBe(0);
    expect(singleLineAnchorX('center', 100)).toBe(50);
    expect(singleLineAnchorX('right', 100)).toBe(100);
    expect(singleLineAnchorX(undefined, 100)).toBe(0);
  });

  it('builds the canvas font string', () => {
    expect(
      singleLineFont({
        fontFamily: "'Bebas Neue'",
        fontSize: 24,
        fontWeight: 'bold',
        fontStyle: 'italic',
      })
    ).toBe('italic bold 24px "Bebas Neue"');
  });

  it('collapses line breaks and runs of spaces', () => {
    expect(normaliseSingleLine(' Next\r\nEpisode   in  3 days ')).toBe(
      'NextEpisode in 3 days'
    );
  });
});

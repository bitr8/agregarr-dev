import { describe, expect, it } from 'vitest';
import { parseColorInput, toSwatchHex } from './color';

describe('parseColorInput', () => {
  it('normalises 6-digit hex to lowercase', () => {
    expect(parseColorInput('#FF0000')).toBe('#ff0000');
  });

  it('normalises 8-digit hex to lowercase', () => {
    expect(parseColorInput('#FF0000AA')).toBe('#ff0000aa');
  });

  it('rejects 3-digit hex', () => {
    expect(parseColorInput('#F00')).toBeNull();
  });

  it('rejects 4-digit hex', () => {
    expect(parseColorInput('#F00A')).toBeNull();
  });

  it('accepts rgb() with spaces and trims whitespace', () => {
    expect(parseColorInput('rgb( 255, 0, 0 )')).toBe('rgb(255,0,0)');
  });

  it('accepts rgba() with spaces and trims whitespace', () => {
    expect(parseColorInput('rgba( 255, 0, 0, 0.5 )')).toBe('rgba(255,0,0,0.5)');
  });

  it('accepts alpha boundary 0', () => {
    expect(parseColorInput('rgba(0,0,0,0)')).toBe('rgba(0,0,0,0)');
  });

  it('accepts alpha boundary 1', () => {
    expect(parseColorInput('rgba(0,0,0,1)')).toBe('rgba(0,0,0,1)');
  });

  it('emits alpha as matched, not reformatted via Number()', () => {
    expect(parseColorInput('rgba(1,2,3,0.50)')).toBe('rgba(1,2,3,0.50)');
    expect(parseColorInput('rgba(1,2,3,1.0)')).toBe('rgba(1,2,3,1.0)');
  });

  it('rejects invalid hex characters', () => {
    expect(parseColorInput('#gggggg')).toBeNull();
  });

  it('rejects wrong-length hex', () => {
    expect(parseColorInput('#12345')).toBeNull();
  });

  it('rejects out-of-range alpha', () => {
    expect(parseColorInput('rgba(0,0,0,2)')).toBeNull();
  });

  it('rejects out-of-range rgb components', () => {
    expect(parseColorInput('rgb(999,0,0)')).toBeNull();
    expect(parseColorInput('rgb(256,0,0)')).toBeNull();
  });

  it('rejects form feed and vertical tab as whitespace', () => {
    expect(parseColorInput('rgb(\f255,0,0)')).toBeNull();
    expect(parseColorInput('rgb(\v255,0,0)')).toBeNull();
  });

  it('rejects named colours', () => {
    expect(parseColorInput('red')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(parseColorInput('')).toBeNull();
  });
});

describe('toSwatchHex', () => {
  it('drops alpha from 8-digit hex', () => {
    expect(toSwatchHex('#11223344')).toBe('#112233');
  });

  it('converts rgba() to 6-digit hex', () => {
    expect(toSwatchHex('rgba(255, 0, 0, 0.5)')).toBe('#ff0000');
  });

  it('falls back to black for 3/4-digit hex (no longer a supported input)', () => {
    expect(toSwatchHex('#f00')).toBe('#000000');
  });
});

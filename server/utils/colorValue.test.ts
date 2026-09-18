import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { COLOR_VALUE_PATTERN } from './colorValue';

describe('COLOR_VALUE_PATTERN', () => {
  it.each([
    '#ff0000',
    '#ff000080',
    'rgba(255, 0, 0, .5)',
    'rgb(0,0,0)',
    'rgb( 255 , 0 , 0 )',
  ])('accepts %s', (value) => {
    expect(COLOR_VALUE_PATTERN.test(value)).toBe(true);
  });

  it.each([
    'red',
    '#f00',
    '#12345',
    'rgba(0,0,0,2)',
    'rgba(0,0,0,0.5) x',
    '#fff"',
    'hsl(0,0%,0%)',
    'rgb(999,0,0)',
    'rgb(256,0,0)',
    'rgb(\f255,0,0)',
    'rgb(\v255,0,0)',
  ])('rejects %s', (value) => {
    expect(COLOR_VALUE_PATTERN.test(value)).toBe(false);
  });

  it('keeps every colour pattern: line in agregarr-api.yml in sync with COLOR_VALUE_PATTERN', () => {
    const specPath = path.join(__dirname, '..', '..', 'agregarr-api.yml');
    const lines = fs.readFileSync(specPath, 'utf-8').split('\n');

    const patterns = lines.flatMap(
      (l) => l.match(/pattern:\s*'(.*)'/)?.[1] ?? []
    );
    const colourPatterns = patterns.filter((p) => /#|rgb/.test(p));

    expect(colourPatterns).toHaveLength(3);
    for (const pattern of colourPatterns) {
      expect(pattern).toBe(COLOR_VALUE_PATTERN.source);
    }
  });
});

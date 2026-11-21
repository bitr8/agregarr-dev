import { TemplateEngine } from '@server/lib/collections/utils/TemplateEngine';
import { describe, expect, it, vi } from 'vitest';
import {
  filterEssentialsValues,
  renderEssentialsTitle,
  resolveSelectionMode,
} from './essentialsSelection';

vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({ plex: { name: 'x' }, main: {} }),
}));

describe('resolveSelectionMode', () => {
  it('keeps an explicit mode', () => {
    expect(resolveSelectionMode('exclude', ['a'])).toBe('exclude');
    expect(resolveSelectionMode('include', [])).toBe('include');
  });

  it('keeps a legacy empty includeValues as include (creates nothing)', () => {
    expect(resolveSelectionMode(undefined, [])).toBe('include');
  });

  it('infers include when only includeValues exist', () => {
    expect(resolveSelectionMode(undefined, ['a'])).toBe('include');
  });

  it('defaults to exclude', () => {
    expect(resolveSelectionMode(undefined, undefined)).toBe('exclude');
  });
});

describe('filterEssentialsValues', () => {
  const all = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];

  it('applies include and exclude lists', () => {
    expect(filterEssentialsValues(all, 'include', ['b'], ['a'])).toEqual([
      { key: 'b' },
    ]);
    expect(filterEssentialsValues(all, 'exclude', ['b'], ['a'])).toEqual([
      { key: 'b' },
      { key: 'c' },
    ]);
  });
});

describe('renderEssentialsTitle', () => {
  const engine = new TemplateEngine();
  const render = (t: string, mt: 'movie' | 'tv') =>
    engine.processTemplate(t, {
      value: 'Drama',
      mediaType: mt,
      subtype: 'genre',
    });

  it('replaces every {value} and the media type tokens like the sync does', () => {
    for (const t of [
      '{value}',
      '{value} {value}',
      '{value} {mediaType}s',
      '{mediaType}: {value}',
      'Best of {value} - {mediaType}',
      'plain',
      '{subtype} {value}',
    ]) {
      for (const mt of ['movie', 'tv'] as const) {
        expect(renderEssentialsTitle(t, 'Drama', mt, 'genre')).toBe(
          render(t, mt)
        );
      }
    }
    expect(
      renderEssentialsTitle('{value} / {value}', 'Drama', 'tv', 'genre')
    ).toBe('Drama / Drama');
  });
});

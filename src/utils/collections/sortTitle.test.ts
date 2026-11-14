import { describe, expect, it } from 'vitest';
import { plexTitleTemplate } from './sortTitle';

describe('plexTitleTemplate', () => {
  it("returns the media type's custom template", () => {
    const config = {
      name: 'Auto Decade Collections',
      template: 'custom',
      customMovieTemplate: 'Auto Collection 60s70s {value}',
      customTVTemplate: '{value} TV',
    };
    expect(plexTitleTemplate(config, 'movie')).toBe(
      'Auto Collection 60s70s {value}'
    );
    expect(plexTitleTemplate(config, 'show')).toBe('{value} TV');
  });

  it("goes by the library's type, not a stale mediaType", () => {
    const config = {
      name: 'New Years Movies',
      mediaType: 'tv',
      template: 'custom',
      customMovieTemplate: 'New Years Movies',
      customTVTemplate: 'Star Wars Day Shows',
    };
    expect(plexTitleTemplate(config, 'movie')).toBeUndefined();
  });

  it('returns a preset template', () => {
    expect(
      plexTitleTemplate({ name: 'Decades', template: '{value}' }, 'movie')
    ).toBe('{value}');
  });

  it('returns nothing when Plex just gets the name, or the title is dynamic', () => {
    expect(
      plexTitleTemplate({ name: 'Holiday Movies' }, 'movie')
    ).toBeUndefined();
    expect(
      plexTitleTemplate(
        { name: 'Holiday Movies', template: 'Holiday Movies' },
        'movie'
      )
    ).toBeUndefined();
    expect(
      plexTitleTemplate(
        { name: 'Mix', template: 'DYNAMIC_RANDOM_TITLE' },
        'movie'
      )
    ).toBeUndefined();
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  getOverlayTargets,
  getPrimaryOverlayTarget,
  isOverlayCompatibleWithLibrary,
  normalizeOverlaySyncTargets,
  setOverlayTargetTags,
  targetsArtwork,
} from './overlayTargets';
import { PRESET_TEMPLATES } from './PresetTemplates';

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));

describe('overlay artwork targets', () => {
  it('treats untagged legacy templates as main artwork', () => {
    expect(getOverlayTargets()).toEqual(['main']);
    expect(getOverlayTargets(['ratings'])).toEqual(['main']);
  });

  it('recognizes explicit targets without case sensitivity', () => {
    expect(getOverlayTargets(['target:Season', 'TARGET:EPISODE'])).toEqual([
      'season',
      'episode',
    ]);
    expect(targetsArtwork(['target:episode'], 'main')).toBe(false);
  });

  it('uses a title-card preview for episode-only templates', () => {
    expect(getPrimaryOverlayTarget(['target:episode'])).toBe('episode');
    expect(getPrimaryOverlayTarget(['target:season'])).toBe('season');
    expect(getPrimaryOverlayTarget(['target:main', 'target:episode'])).toBe(
      'main'
    );
    expect(getPrimaryOverlayTarget()).toBe('main');
  });

  it('replaces target tags while preserving ordinary tags', () => {
    expect(
      setOverlayTargetTags(['ratings', 'target:main'], ['season', 'episode'])
    ).toEqual(['ratings', 'target:season', 'target:episode']);
  });

  it('hides child-artwork templates from movie libraries', () => {
    expect(isOverlayCompatibleWithLibrary(['target:season'], 'movie')).toBe(
      false
    );
    expect(isOverlayCompatibleWithLibrary(['target:episode'], 'movie')).toBe(
      false
    );
    expect(isOverlayCompatibleWithLibrary(['target:main'], 'movie')).toBe(true);
    expect(isOverlayCompatibleWithLibrary(['target:episode'], 'show')).toBe(
      true
    );
  });

  it('defaults TV syncs to all artwork while preserving explicit job opt-outs', () => {
    expect(normalizeOverlaySyncTargets(undefined, 'show')).toEqual([
      'main',
      'season',
      'episode',
    ]);
    expect(normalizeOverlaySyncTargets(undefined, 'movie')).toEqual(['main']);
    expect(normalizeOverlaySyncTargets([], 'show')).toEqual([]);
  });

  it('deduplicates targets and strips TV-only targets from movie libraries', () => {
    expect(
      normalizeOverlaySyncTargets(
        ['episode', 'main', 'season', 'main', 'invalid'],
        'movie'
      )
    ).toEqual(['main']);
    expect(
      normalizeOverlaySyncTargets(['episode', 'main', 'episode'], 'show')
    ).toEqual(['episode', 'main']);
  });

  it('ships correctly-sized season and episode IMDb presets', () => {
    const season = PRESET_TEMPLATES.find(
      (preset) => preset.name === 'IMDb Rating - Season Poster'
    );
    const episode = PRESET_TEMPLATES.find(
      (preset) => preset.name === 'IMDb Rating - Episode Card'
    );

    expect(season?.tags).toContain('target:season');
    expect(season?.templateData).toMatchObject({ width: 1000, height: 1500 });
    expect(episode?.tags).toContain('target:episode');
    expect(episode?.templateData).toMatchObject({ width: 1920, height: 1080 });
    expect(episode?.applicationCondition).toEqual({
      sections: [
        {
          rules: [{ field: 'imdbRating', operator: 'gte', value: 0 }],
        },
      ],
    });
  });

  it('ships target-aware TMDB rating presets', () => {
    const main = PRESET_TEMPLATES.find(
      (preset) => preset.name === 'TMDB Rating'
    );
    const season = PRESET_TEMPLATES.find(
      (preset) => preset.name === 'TMDB Rating - Season Poster'
    );
    const episode = PRESET_TEMPLATES.find(
      (preset) => preset.name === 'TMDB Rating - Episode Card'
    );

    expect(main?.tags).not.toContain('target:season');
    expect(main?.templateData).toMatchObject({ width: 1000, height: 1500 });
    expect(season?.tags).toContain('target:season');
    expect(season?.templateData).toMatchObject({ width: 1000, height: 1500 });
    expect(episode?.tags).toContain('target:episode');
    expect(episode?.templateData).toMatchObject({
      width: 1920,
      height: 1080,
    });
    expect(episode?.applicationCondition).toEqual({
      sections: [
        {
          rules: [{ field: 'tmdbRating', operator: 'gte', value: 0 }],
        },
      ],
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  supportsTargetUser,
  targetedConfigs,
  withoutTargetUser,
  withSupportedTargetUser,
} from './targetUserSupport';

describe('supportsTargetUser', () => {
  it('is off where the sync ignores it', () => {
    expect(supportsTargetUser('overseerr', 'users')).toBe(false);
    expect(supportsTargetUser('tmdb', 'auto_franchise')).toBe(false);
    expect(supportsTargetUser('plex', 'genre')).toBe(false);
  });

  it('is on for label collections, ordinary sources and filtered hubs', () => {
    expect(supportsTargetUser('plex', 'label')).toBe(true);
    expect(supportsTargetUser('trakt', 'trending')).toBe(true);
    expect(supportsTargetUser('filtered_hub', 'recently_added')).toBe(true);
  });
});

describe('target user stripping', () => {
  const base = { id: 'a', targetUserId: '42', targetUserLabel: 'viewer' };

  it('removes both fields for an unsupported type', () => {
    const out = withSupportedTargetUser({
      ...base,
      type: 'overseerr',
      subtype: 'users',
    });
    expect(out).not.toHaveProperty('targetUserId');
    expect(out).not.toHaveProperty('targetUserLabel');
    expect(out.id).toBe('a');
  });

  it('keeps them for supported types', () => {
    for (const [type, subtype] of [
      ['trakt', 'trending'],
      ['plex', 'label'],
      ['filtered_hub', 'recently_added'],
    ]) {
      const out = withSupportedTargetUser({ ...base, type, subtype });
      expect(out.targetUserId).toBe('42');
      expect(out.targetUserLabel).toBe('viewer');
    }
  });

  it('withoutTargetUser always strips', () => {
    const out = withoutTargetUser({ ...base, name: 'Hub' });
    expect(out).toEqual({ id: 'a', name: 'Hub' });
  });
});

describe('targetedConfigs', () => {
  it('keeps only configs whose type honours a target user', () => {
    const configs = [
      { id: 'a', type: 'trakt', subtype: 'trending', targetUserId: 7 },
      { id: 'b', type: 'plex', subtype: 'genre', targetUserId: 7 },
      { id: 'c', type: 'overseerr', subtype: 'users', targetUserId: 7 },
      { id: 'd', type: 'plex', subtype: 'label', targetUserId: 7 },
      { id: 'e', type: 'trakt', subtype: 'popular' },
    ];
    expect(targetedConfigs(configs).map((c) => c.id)).toEqual(['a', 'd']);
  });
});

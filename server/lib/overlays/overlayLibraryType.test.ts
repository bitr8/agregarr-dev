import { expect, it, vi } from 'vitest';
import { getOverlayLibraryType } from './overlayLibraryType';
const settings = vi.hoisted(() => ({
  plex: {
    libraries: [
      { key: '1', type: 'movie' },
      { key: '2', type: 'show' },
    ],
  },
}));
vi.mock('@server/lib/settings', () => ({ getSettings: () => settings }));

it('prefers Plex library types and falls back only for unknown libraries', () => {
  expect(getOverlayLibraryType('1', 'show')).toBe('movie');
  expect(getOverlayLibraryType('2', 'movie')).toBe('show');
  expect(getOverlayLibraryType('unknown', 'show')).toBe('show');
});

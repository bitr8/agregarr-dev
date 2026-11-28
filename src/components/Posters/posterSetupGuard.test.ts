import { describe, expect, it } from 'vitest';
import { getPlexContinueAction } from './posterSetupGuard';

describe('getPlexContinueAction', () => {
  it('always asks for the clean-posters confirmation on first setup with Plex', () => {
    expect(
      getPlexContinueAction({ isInitialSetup: true, selectedSource: 'plex' })
    ).toBe('confirm');
  });

  it('saves directly for other sources on first setup', () => {
    expect(
      getPlexContinueAction({ isInitialSetup: true, selectedSource: 'tmdb' })
    ).toBe('save');
    expect(
      getPlexContinueAction({ isInitialSetup: true, selectedSource: 'local' })
    ).toBe('save');
  });

  it('saves directly once setup is complete (re-download has its own button)', () => {
    expect(
      getPlexContinueAction({ isInitialSetup: false, selectedSource: 'plex' })
    ).toBe('save');
  });
});

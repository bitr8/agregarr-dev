export type PlexContinueAction = 'confirm' | 'save';

export function getPlexContinueAction({
  isInitialSetup,
  selectedSource,
}: {
  isInitialSetup: boolean;
  selectedSource: 'tmdb' | 'plex' | 'local';
}): PlexContinueAction {
  return isInitialSetup && selectedSource === 'plex' ? 'confirm' : 'save';
}

import { getSettings } from '@server/lib/settings';

export function getOverlayLibraryType(
  libraryId: string,
  storedType: 'movie' | 'show'
): 'movie' | 'show' {
  const library = getSettings().plex.libraries.find(
    (item) => item.key === libraryId
  );
  return library ? (library.type === 'show' ? 'show' : 'movie') : storedType;
}

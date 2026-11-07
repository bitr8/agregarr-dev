import type { PlexLibraryItem } from '@server/api/plexapi';

const FILENAME_EDITION = /\{edition-([^}]+)\}/i;

export function resolveEdition(
  item: Pick<PlexLibraryItem, 'editionTitle' | 'Media'>
): string | undefined {
  const fromPlex = item.editionTitle?.trim();
  if (fromPlex) return fromPlex;

  const file = item.Media?.[0]?.Part?.[0]?.file;
  if (!file) return undefined;
  const name = file.split(/[\\/]/).pop() ?? '';
  return name.match(FILENAME_EDITION)?.[1].trim() || undefined;
}

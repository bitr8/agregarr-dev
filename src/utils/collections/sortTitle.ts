/**
 * Client-side mirror of the server's sort title rules
 * (server/lib/collections/core/CollectionUtilities.ts), kept here rather
 * than imported to avoid pulling server code across the client bundle
 * boundary.
 *
 * It lives in one module because it was previously hand-copied into each
 * component that needed it, and the copies drifted: the library list learned
 * to ignore a sort title Agregarr owns while the config form kept showing it,
 * so a demoted collection sorted under V while its Sort Title field still
 * read "ZZZ_Video Games". Anything mirroring the server belongs here, so a
 * server change has exactly one place to land on the client.
 */

// Must match PROMOTED_SORT_TITLE_RANK_WIDTH in CollectionUtilities.ts. 3
// digits matches Kometa's !010_/!020_ convention; see that constant for why
// the width is an interop contract rather than cosmetics.
export const PROMOTED_SORT_TITLE_RANK_WIDTH = 3;

/**
 * True where the value in Plex is one Agregarr wrote (and may therefore
 * replace), false where a human typed it in Plex and it has to be left
 * alone.
 *
 * everManaged (everLibraryPromoted) covers the case the other checks cannot
 * see: a value written through a Sort Title override that has since been
 * cleared. Nothing records what that override produced, so "ZZZ_Video Games"
 * is indistinguishable from a human's edit without it.
 */
export function agregarrOwnsSortTitle(
  titleSort: string | undefined,
  name: string,
  everManaged: boolean | undefined
): boolean {
  const current = titleSort?.trim();
  if (!current) return true;
  if (current === name.trim()) return true;
  if (/^!\d+_/.test(current)) return true;
  return everManaged === true;
}

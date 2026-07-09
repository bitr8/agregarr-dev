import type { PlexMetadata } from '@server/api/plexapi';

/**
 * Result of a single guarded metadata fetch. Distinguishes a confirmed
 * absence ('not_found') from an ambiguous transport failure ('error') so
 * callers (e.g. season overlay cleanup) never treat a network blip as a
 * deletion. See PlexAPI.getMetadataSafe.
 *
 * Pure classifiers live in this dependency-free module (only a type import from
 * plexapi, erased at runtime) so they can be unit-tested without dragging in
 * the full Plex client graph.
 */
export type PlexMetadataSafeResult =
  | { status: 'ok'; meta: PlexMetadata }
  | { status: 'not_found' }
  | { status: 'error' };

interface PlexMetadataContainerShape {
  MediaContainer?: { Metadata?: PlexMetadata[] };
}

/**
 * True only when a plex-api error message reports an HTTP 404.
 *
 * plex-api (v5.3.2) exposes no structured status code; the status is only in
 * the message as "response code: <n>" (verified empirically against nostromo:
 * `Plex Server didnt respond with a valid 2xx status code, response code: 404`).
 * We parse that exact number instead of a bare `.includes('404')`, so a
 * ratingKey or URL that happens to contain the digits 404 combined with an
 * unrelated failure can never be misread as a deletion. The caller
 * (getMetadataSafe) gates a destructive cleanup on this.
 */
export function isPlexNotFoundError(errorMessage: string): boolean {
  // Capture the FULL run of digits (not a fixed 3) so a hypothetical malformed
  // "response code: 4040" compares as "4040" !== "404" rather than substring
  // matching "404".
  const statusMatch = errorMessage.match(/response code:\s*(\d+)/i);
  return statusMatch?.[1] === '404';
}

/**
 * Classify a successful (non-throwing) plex-api metadata response. Only a
 * well-formed Plex MediaContainer is trustworthy: a non-Plex 2xx (reverse
 * proxy / auth / captive-portal page) arrives as a string/Buffer or an object
 * with no MediaContainer and must be 'error', never 'not_found'. A well-formed
 * container with no item is a confirmed absence.
 */
export function classifyPlexMetadataResponse(
  response: unknown
): PlexMetadataSafeResult {
  const container = (response as PlexMetadataContainerShape | undefined)
    ?.MediaContainer;
  if (!container || typeof container !== 'object') {
    return { status: 'error' };
  }
  const meta = container.Metadata?.[0];
  return meta ? { status: 'ok', meta } : { status: 'not_found' };
}

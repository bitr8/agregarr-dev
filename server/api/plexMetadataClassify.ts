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

/**
 * What a collection ratingKey turned out to be when we read it back.
 *
 * 'ambiguous' must be handled exactly like 'present': we could not verify the
 * key, so nothing destructive may follow.
 */
export type CollectionKeyState =
  | 'present'
  | 'absent'
  | 'not-a-collection'
  | 'ambiguous';

/** Plex item types a collection ratingKey could be confused with. */
const MEDIA_ITEM_TYPES = new Set<string>([
  'movie',
  'show',
  'season',
  'episode',
]);

/**
 * Decide what a ratingKey is from a guarded metadata read.
 *
 * Callers reach for this after a WRITE to a collection failed with 404. A failed
 * write never proves the collection is gone. Verified against a live Plex
 * server: `PUT /library/sections/{section}/all?type=18&id={key}` returns 404
 * when the *section* does not exist, even for a healthy populated collection,
 * and `PUT /library/collections/{key}/prefs` returns 404 when the key is not a
 * collection at all. Only a read can tell those apart from a real absence, and
 * only 'absent' or 'not-a-collection' may be acted on.
 *
 * Plex reports `type: "collection"` for collections. PlexMetadata models media
 * items so the literal is absent from its union; it is read as a plain string
 * rather than widening that type across every overlay call site.
 */
export function classifyCollectionKey(
  result: PlexMetadataSafeResult
): CollectionKeyState {
  if (result.status === 'not_found') {
    return 'absent';
  }
  if (result.status === 'error') {
    return 'ambiguous';
  }

  const plexType: string = result.meta.type;

  if (plexType === 'collection') {
    return 'present';
  }

  // Only a type we positively recognise as a media item may clear a stored key.
  // An unknown or missing type (a Plex rename, a partial response, a playlist or
  // music item on a reused ratingKey) is ambiguous, so the sync leaves the key
  // alone rather than recreating over the top of it.
  //
  // The trade-off is deliberate: a key pointing at an unrecognised type is held
  // forever and warns every cycle, rather than being cleared. Do not "fix" that
  // by widening this set on a hunch — every type added here gains the power to
  // discard a stored key, which is the class of assumption this module exists to
  // prevent. Add a type only once you have confirmed what Plex returns for it.
  return MEDIA_ITEM_TYPES.has(plexType) ? 'not-a-collection' : 'ambiguous';
}

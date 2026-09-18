import { extractContentAddressedPosterRef } from '@server/utils/posterUrlHelpers';

export interface PlexPosterMetadata {
  selected?: string | number | boolean;
  thumb?: string;
  key?: string;
  ratingKey?: string;
}

const isSelectedPoster = (poster: PlexPosterMetadata): boolean =>
  poster.selected === '1' || poster.selected === 1 || poster.selected === true;

const getContentAddressedReference = (
  poster: PlexPosterMetadata
): string | null => {
  for (const value of [poster.ratingKey, poster.thumb, poster.key]) {
    const reference = extractContentAddressedPosterRef(value);
    if (reference) {
      return reference;
    }
  }

  return null;
};

const getPosterReference = (poster: PlexPosterMetadata): string | undefined =>
  getContentAddressedReference(poster) ||
  poster.ratingKey ||
  poster.thumb ||
  poster.key;

const isUploadedPoster = (poster: PlexPosterMetadata): boolean =>
  getContentAddressedReference(poster)?.startsWith('upload://posters/') ??
  false;

/**
 * Prefer Plex's selected uploaded poster (including Posterizarr uploads), then
 * any selected poster. When Plex omits the selected marker, return null so the
 * caller can use the library item's current thumb instead of guessing between
 * stale manual, Posterizarr, or Agregarr uploads.
 */
export const selectPreferredPosterReference = (
  posters: PlexPosterMetadata[]
): string | null => {
  const preferredPoster =
    posters.find(
      (poster) => isSelectedPoster(poster) && isUploadedPoster(poster)
    ) ||
    posters.find(
      (poster) => isSelectedPoster(poster) && getPosterReference(poster)
    );

  return preferredPoster ? getPosterReference(preferredPoster) || null : null;
};

/**
 * Use Plex's content-addressed file endpoint for upload:// and metadata://
 * references. Unlike /thumb/{version}, this keeps the download pinned to the
 * selected poster even if another process changes Plex's selection mid-job.
 */
export const resolvePlexPosterDownloadPath = (
  posterReference: string,
  ratingKey: string
): string => {
  const contentAddressedReference =
    extractContentAddressedPosterRef(posterReference);

  if (!contentAddressedReference) {
    return posterReference;
  }

  return `/library/metadata/${ratingKey}/file?url=${encodeURIComponent(
    contentAddressedReference
  )}`;
};

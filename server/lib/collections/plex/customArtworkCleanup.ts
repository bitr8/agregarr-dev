import type PlexAPI from '@server/api/plexapi';
import metadataService from '@server/lib/metadata/MetadataTrackingService';
import { getThemePath } from '@server/lib/themeStorage';
import { getWallpaperPath } from '@server/lib/wallpaperStorage';
import logger from '@server/logger';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';

interface ArtworkConfig {
  readonly enableCustomWallpaper?: boolean;
  readonly customWallpaper?: string | Record<string, string>;
  readonly enableCustomTheme?: boolean;
  readonly customTheme?: string | Record<string, string>;
}

const fileFor = (
  value: string | Record<string, string> | undefined,
  libraryKey: string
): string | undefined =>
  typeof value === 'string' ? value || undefined : value?.[libraryKey];

const sha1Of = async (path: string): Promise<string | null> => {
  try {
    return createHash('sha1')
      .update(await fs.readFile(path))
      .digest('hex');
  } catch {
    return null;
  }
};

/**
 * Removes a wallpaper or theme from a Plex collection once it is switched off
 * or its file removed, but only while Plex still shows the one Agregarr
 * applied. Anything chosen in Plex since is left alone.
 */
export async function clearRemovedCustomArtwork(
  plexClient: PlexAPI,
  collectionRatingKey: string,
  config: ArtworkConfig | undefined,
  libraryKey: string
): Promise<void> {
  const kinds = [
    {
      kind: 'art' as const,
      wanted:
        !!config?.enableCustomWallpaper &&
        !!fileFor(config.customWallpaper, libraryKey),
      pathFor: getWallpaperPath,
    },
    {
      kind: 'theme' as const,
      wanted:
        !!config?.enableCustomTheme &&
        !!fileFor(config.customTheme, libraryKey),
      pathFor: getThemePath,
    },
  ];

  for (const { kind, wanted, pathFor } of kinds) {
    if (wanted) continue;
    try {
      const applied = await metadataService.getAppliedArtworkFilename(
        collectionRatingKey,
        kind
      );
      if (!applied) continue;
      const appliedSha = await sha1Of(pathFor(applied));
      const selectedSha = await plexClient.getSelectedUploadSha(
        collectionRatingKey,
        kind
      );
      if (appliedSha && appliedSha === selectedSha) {
        await plexClient.deleteArtwork(collectionRatingKey, kind);
      }
      await metadataService.clearArtworkRecord(collectionRatingKey, kind);
    } catch (error) {
      logger.warn(`Failed to remove ${kind} from collection`, {
        label: 'Collections',
        collectionRatingKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

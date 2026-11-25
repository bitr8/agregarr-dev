import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

process.env.CONFIG_DIRECTORY = fs.mkdtempSync(
  path.join(os.tmpdir(), 'agregarr-preexisting-')
);

const existing = {
  id: 'kept-id',
  collectionRatingKey: '10',
  name: 'The Matrix Collection',
  libraryId: '1',
  libraryName: 'Movies',
  mediaType: 'movie',
  sortOrderHome: 1,
  sortOrderLibrary: 0,
  isLibraryPromoted: false,
  visibilityConfig: {
    usersHome: false,
    serverOwnerHome: false,
    libraryRecommended: false,
  },
  isActive: true,
  collectionType: 'pre_existing',
  collectionSuffixMode: 'strip',
  collectionSuffixRenameFailed: true,
};

const rediscovered = {
  collectionRatingKey: '10',
  name: 'The Matrix Collection',
  libraryId: '1',
  libraryName: 'Movies',
  mediaType: 'movie',
  visibilityConfig: existing.visibilityConfig,
  collectionType: 'pre_existing',
};

describe('saveConfigs keeps the suffix settings on rediscovery', () => {
  const load = async () => {
    const { getSettings } = await import('@server/lib/settings');
    const settings = getSettings();
    settings.plex.preExistingCollectionConfigs = [{ ...existing }] as never;
    const { preExistingCollectionConfigService } = await import(
      './PreExistingCollectionConfigService'
    );
    return { settings, service: preExistingCollectionConfigService };
  };

  it('keeps the mode and the failed flag', async () => {
    const { settings, service } = await load();
    service.saveConfigs([rediscovered] as never);
    const saved = settings.plex.preExistingCollectionConfigs?.[0];
    expect(saved?.id).toBe('kept-id');
    expect(saved?.collectionSuffixMode).toBe('strip');
    expect(saved?.collectionSuffixRenameFailed).toBe(true);
  });
});

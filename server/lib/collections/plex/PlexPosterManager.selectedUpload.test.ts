import type PlexAPI from '@server/api/plexapi';
import PlexPosterManager from '@server/lib/collections/plex/PlexPosterManager';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/lib/settings', () => ({ getSettings: () => ({}) }));
vi.mock('@server/logger', () => ({ default: { info: vi.fn() } }));

const SHA = '2c7b84bdbd47546af3d7fd4ca483714c70f86dcd';

const manager = (response: unknown) =>
  new PlexPosterManager({
    plexClient: { query: async () => response },
  } as unknown as PlexAPI);

describe('PlexPosterManager.getSelectedUploadSha', () => {
  it('reads the selected upload from the key Plex returns', async () => {
    const m = manager({
      MediaContainer: {
        Metadata: [
          {
            key: '/library/metadata/1/file?url=metadata%3A%2F%2Fart',
            selected: false,
          },
          {
            key: `/library/metadata/1/file?url=upload%3A%2F%2Fart%2F${SHA}`,
            selected: true,
          },
        ],
      },
    });
    await expect(m.getSelectedUploadSha('1', 'art')).resolves.toBe(SHA);
  });

  it('reads it from ratingKey with selected as "1"', async () => {
    const m = manager({
      MediaContainer: {
        Metadata: [{ ratingKey: `upload://themes/${SHA}`, selected: '1' }],
      },
    });
    await expect(m.getSelectedUploadSha('1', 'theme')).resolves.toBe(SHA);
  });

  it('returns null when the selection is not an upload of that kind', async () => {
    const m = manager({
      MediaContainer: {
        Metadata: [{ ratingKey: `upload://themes/${SHA}`, selected: true }],
      },
    });
    await expect(m.getSelectedUploadSha('1', 'art')).resolves.toBeNull();
  });

  it('throws on a response it cannot read', async () => {
    await expect(
      manager(Buffer.from('<xml/>')).getSelectedUploadSha('1', 'art')
    ).rejects.toThrow();
  });
});

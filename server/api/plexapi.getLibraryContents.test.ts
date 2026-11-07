import { describe, expect, it, vi } from 'vitest';
import PlexAPI from './plexapi';

describe('getLibraryContents (full-sync item source)', () => {
  it('requests the section list with guids and keeps editionTitle on rows', async () => {
    const query = vi.fn(async () => ({
      MediaContainer: {
        totalSize: 1,
        Metadata: [{ ratingKey: '10', type: 'movie', editionTitle: 'IMAX' }],
      },
    }));

    const result = await (
      PlexAPI.prototype.getLibraryContents as (
        this: { plexClient: { query: typeof query } },
        id: string,
        opts: { offset: number; size: number }
      ) => Promise<{ items: { editionTitle?: string }[] }>
    ).call({ plexClient: { query } }, '4', { offset: 0, size: 50 });

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ uri: '/library/sections/4/all?includeGuids=1' })
    );
    expect(result.items[0].editionTitle).toBe('IMAX');
  });
});

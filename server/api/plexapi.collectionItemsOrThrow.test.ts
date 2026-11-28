import { expect, it, vi } from 'vitest';
import PlexAPI from './plexapi';

const call = (query: () => Promise<unknown>) =>
  (
    PlexAPI.prototype.getCollectionItemsOrThrow as (
      this: { plexClient: { query: typeof query } },
      rk: string
    ) => Promise<string[]>
  ).call({ plexClient: { query } }, '9');

it('throws when Plex returns no MediaContainer', async () => {
  await expect(call(vi.fn(async () => ({})))).rejects.toThrow(/MediaContainer/);
});

it('returns an empty list for an empty collection', async () => {
  await expect(
    call(vi.fn(async () => ({ MediaContainer: { size: 0 } })))
  ).resolves.toEqual([]);
});

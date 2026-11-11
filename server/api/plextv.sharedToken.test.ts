import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/lib/settings', () => ({ getSettings: () => ({}) }));

import PlexTvAPI from './plextv';

const xml = (id: number) =>
  `<MediaContainer><SharedServer userID="${id}" accessToken="tok-${id}"/></MediaContainer>`;

describe('PlexTvAPI.getSharedUserToken', () => {
  it('finds the token by user id with a request timeout and cache ttl', async () => {
    const api = new PlexTvAPI('admin');
    const get = vi
      .spyOn(
        api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>,
        'get'
      )
      .mockResolvedValue(xml(11));

    expect(await api.getSharedUserToken('m-a', 11)).toBe('tok-11');
    expect(await api.getSharedUserToken('m-a', 12)).toBeNull();

    expect(get).toHaveBeenCalledWith(
      '/api/servers/m-a/shared_servers',
      expect.objectContaining({ timeout: 10000, responseType: 'text' }),
      300
    );
  });
});

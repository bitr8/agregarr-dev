import { describe, expect, it, vi } from 'vitest';
import Settings from './settings';

type Cfg = Record<string, unknown>;

const makeSettings = (plex: {
  collectionConfigs?: Cfg[];
  hubConfigs?: Cfg[];
  preExistingCollectionConfigs?: Cfg[];
}) => {
  const settings = new Settings();
  const save = vi
    .spyOn(settings, 'save')
    .mockImplementation(() => undefined as never);
  const data = (settings as unknown as { data: { plex: typeof plex } }).data;
  Object.assign(data.plex, plex);
  return { settings, save, data };
};

describe('stripUnsupportedTargetUsers', () => {
  it('removes a saved target user where the sync cannot honour it', () => {
    const { settings, save, data } = makeSettings({
      collectionConfigs: [
        { id: 'a', type: 'trakt', subtype: 'trending', targetUserId: '7' },
        {
          id: 'b',
          type: 'plex',
          subtype: 'genre',
          targetUserId: '7',
          targetUserLabel: 'x',
        },
        { id: 'c', type: 'plex', subtype: 'label', targetUserId: '7' },
        {
          id: 'd',
          type: 'filtered_hub',
          subtype: 'recently_added',
          targetUserId: '7',
        },
      ],
      hubConfigs: [{ id: 'h', targetUserId: '7' }],
      preExistingCollectionConfigs: [{ id: 'p', targetUserId: '7' }],
    });

    settings.stripUnsupportedTargetUsers();

    const byId = Object.fromEntries(
      (data.plex.collectionConfigs ?? []).map((c) => [c.id, c])
    );
    expect(byId.a.targetUserId).toBe('7');
    expect(byId.c.targetUserId).toBe('7');
    expect(byId.d.targetUserId).toBe('7');
    expect('targetUserId' in byId.b).toBe(false);
    expect('targetUserLabel' in byId.b).toBe(false);
    expect('targetUserId' in (data.plex.hubConfigs?.[0] ?? {})).toBe(false);
    expect(
      'targetUserId' in (data.plex.preExistingCollectionConfigs?.[0] ?? {})
    ).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('does not save when nothing changes', () => {
    const { settings, save } = makeSettings({
      collectionConfigs: [{ id: 'a', type: 'trakt', targetUserId: '7' }],
    });

    settings.stripUnsupportedTargetUsers();

    expect(save).not.toHaveBeenCalled();
  });
});

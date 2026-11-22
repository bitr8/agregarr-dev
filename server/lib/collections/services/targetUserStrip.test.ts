import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  save: () => undefined,
  plex: {
    hubConfigs: [] as Record<string, unknown>[],
    preExistingCollectionConfigs: [] as Record<string, unknown>[],
  },
}));

vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', () => ({ getSettings: () => settings }));

import { DefaultHubConfigService } from './DefaultHubConfigService';
import { PreExistingCollectionConfigService } from './PreExistingCollectionConfigService';

describe('stale target user on hubs and pre-existing collections', () => {
  beforeEach(() => {
    settings.plex.hubConfigs = [
      {
        id: 'h1',
        name: 'Hub',
        libraryId: '1',
        hubIdentifier: 'movie.recentlyadded',
        targetUserId: '42',
        targetUserLabel: 'viewer',
      },
    ];
    settings.plex.preExistingCollectionConfigs = [
      {
        id: 'p1',
        name: 'Pre',
        libraryId: '1',
        targetUserId: '42',
        targetUserLabel: 'viewer',
      },
    ];
  });

  it('default hub save drops a stored target user', () => {
    const svc = new DefaultHubConfigService();
    const saved = svc.updateSettings('h1', { isActive: true } as never);
    expect(saved).not.toHaveProperty('targetUserId');
    expect(saved).not.toHaveProperty('targetUserLabel');
  });

  it('pre-existing collection save drops a stored target user', () => {
    const svc = new PreExistingCollectionConfigService();
    const saved = svc.updateSettings('p1', { isActive: true } as never);
    expect(saved).not.toHaveProperty('targetUserId');
    expect(saved).not.toHaveProperty('targetUserLabel');
  });
});

describe('raw array saves', () => {
  it('drop target user fields from hubs and pre-existing collections', () => {
    new DefaultHubConfigService().saveExistingConfigs([
      { id: 'h2', targetUserId: '42', targetUserLabel: 'viewer' } as never,
    ]);
    new PreExistingCollectionConfigService().saveExistingConfigs([
      { id: 'p2', targetUserId: '42', targetUserLabel: 'viewer' } as never,
    ]);
    expect(settings.plex.hubConfigs[0]).not.toHaveProperty('targetUserId');
    expect(settings.plex.preExistingCollectionConfigs[0]).not.toHaveProperty(
      'targetUserId'
    );
  });
});

import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  settings: {
    statistics: { provider: 'tautulli' },
    tautulli: {} as Record<string, unknown>,
    tracearr: {} as Record<string, unknown>,
    plex: {},
  },
}));

vi.mock('@server/lib/settings', () => ({
  getSettings: () => state.settings,
}));

vi.mock('@server/lib/cache', () => ({
  default: {
    getCache: () => ({ data: { get: () => undefined, set: () => undefined } }),
  },
}));

vi.mock('@server/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@server/api/plexapi', () => ({ default: class {} }));

import {
  getStatisticsProvider,
  getStatisticsProviderDisplayName,
  getStatisticsProviderType,
  isStatisticsProviderConfigured,
} from './index';

describe('statistics provider selection', () => {
  it('defaults to Tautulli when nothing is selected', () => {
    state.settings.statistics = undefined as never;
    expect(getStatisticsProviderType()).toBe('tautulli');
    expect(getStatisticsProviderDisplayName()).toBe('Tautulli');
  });

  it('reports the selected provider as unconfigured without host and key', () => {
    state.settings.statistics = { provider: 'tracearr' };
    state.settings.tracearr = { hostname: 'tracearr' };
    state.settings.tautulli = { hostname: 't', apiKey: 'k' };

    expect(isStatisticsProviderConfigured()).toBe(false);
    expect(isStatisticsProviderConfigured('tautulli')).toBe(true);
    expect(getStatisticsProvider()).toBeNull();
  });

  it('builds the Tracearr provider when selected and configured', () => {
    state.settings.statistics = { provider: 'tracearr' };
    state.settings.tracearr = { hostname: 'tracearr', apiKey: 'trr_pub_x' };

    const provider = getStatisticsProvider();
    expect(provider?.type).toBe('tracearr');
    expect(provider?.displayName).toBe('Tracearr');
  });

  it('builds the Tautulli provider when selected and configured', () => {
    state.settings.statistics = { provider: 'tautulli' };
    state.settings.tautulli = { hostname: 't', apiKey: 'k' };

    expect(getStatisticsProvider()?.type).toBe('tautulli');
  });
});

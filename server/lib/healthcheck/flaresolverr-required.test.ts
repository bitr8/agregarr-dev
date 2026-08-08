import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ settings: undefined as unknown }));

// Fall back to real settings: TemplateEngine calls getSettings() at import time
vi.mock('@server/lib/settings', async (importOriginal) => {
  const actual = (await importOriginal()) as { getSettings: () => unknown };
  return {
    ...actual,
    getSettings: () => state.settings ?? actual.getSettings(),
  };
});

import { flareSolverrRequiredCheck } from '@server/lib/healthcheck';

const settingsWith = (
  configs: Record<string, unknown>[],
  flareSolverrUrl?: string
) => ({
  main: { flareSolverrUrl },
  plex: { collectionConfigs: configs },
});

describe('flareSolverrRequiredCheck', () => {
  it('skips when no networks configs exist', async () => {
    state.settings = settingsWith([{ type: 'trakt' }, { type: 'letterboxd' }]);
    expect((await flareSolverrRequiredCheck.run()).status).toBe('skipped');
  });

  it('errors when a networks config exists without a solver URL', async () => {
    state.settings = settingsWith([{ type: 'networks' }]);
    const result = await flareSolverrRequiredCheck.run();
    expect(result.status).toBe('error');
    expect(result.message).toContain('Byparr');
  });

  it('detects networks sources inside multi-source configs', async () => {
    state.settings = settingsWith([
      {
        type: 'multi-source',
        sources: [{ type: 'trakt' }, { type: 'networks' }],
      },
    ]);
    expect((await flareSolverrRequiredCheck.run()).status).toBe('error');
  });

  it('still requires the solver for missing-flagged configs', async () => {
    state.settings = settingsWith([{ type: 'networks', missing: true }]);
    expect((await flareSolverrRequiredCheck.run()).status).toBe('error');
  });

  it('passes when the solver URL is set', async () => {
    state.settings = settingsWith(
      [{ type: 'networks' }],
      'http://flaresolverr:8191'
    );
    expect((await flareSolverrRequiredCheck.run()).status).toBe('ok');
  });
});

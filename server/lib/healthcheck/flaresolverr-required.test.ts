import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ settings: undefined as unknown }));

// Fall back to real settings: TemplateEngine calls getSettings() at import time
vi.mock('@server/lib/settings', async (importOriginal) => {
  const actual = (await importOriginal()) as { getSettings: () => unknown };
  return {
    ...actual,
    getSettings: () => state.settings ?? actual.getSettings(),
  };
});

vi.mock('axios', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

import {
  connectionFlareSolverrCheck,
  flareSolverrRequiredCheck,
} from '@server/lib/healthcheck';

const mockGet = vi.mocked(axios.get);

const settingsWith = (
  configs: Record<string, unknown>[],
  cloudflareSolvers?: { id: string; name: string; url: string }[]
) => ({
  main: { cloudflareSolvers },
  plex: { collectionConfigs: configs },
});

const solverOne = {
  id: 'a',
  name: 'FlareSolverr',
  url: 'http://solver-a:8191',
};
const solverTwo = { id: 'b', name: 'Byparr', url: 'http://solver-b:8191' };

describe('flareSolverrRequiredCheck', () => {
  it('skips when no networks configs exist', async () => {
    state.settings = settingsWith([{ type: 'trakt' }, { type: 'letterboxd' }]);
    expect((await flareSolverrRequiredCheck.run()).status).toBe('skipped');
  });

  it('errors when a networks config exists without any solver', async () => {
    state.settings = settingsWith([{ type: 'networks' }]);
    const result = await flareSolverrRequiredCheck.run();
    expect(result.status).toBe('error');
    expect(result.message).toContain('Byparr');
  });

  it('errors when the solver list is empty', async () => {
    state.settings = settingsWith([{ type: 'networks' }], []);
    expect((await flareSolverrRequiredCheck.run()).status).toBe('error');
  });

  it('errors when entries exist but none has a URL', async () => {
    state.settings = settingsWith(
      [{ type: 'networks' }],
      [{ id: 'a', name: 'Empty', url: '' }]
    );
    expect((await flareSolverrRequiredCheck.run()).status).toBe('error');
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

  it('passes when a solver is configured', async () => {
    state.settings = settingsWith([{ type: 'networks' }], [solverOne]);
    expect((await flareSolverrRequiredCheck.run()).status).toBe('ok');
  });
});

describe('connectionFlareSolverrCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips when no solvers are configured', async () => {
    state.settings = settingsWith([]);
    expect((await connectionFlareSolverrCheck.run()).status).toBe('skipped');
    state.settings = settingsWith([], []);
    expect((await connectionFlareSolverrCheck.run()).status).toBe('skipped');
  });

  it('reports ok with a count when all solvers respond', async () => {
    state.settings = settingsWith([], [solverOne, solverTwo]);
    mockGet.mockResolvedValue({ data: {} });
    const result = await connectionFlareSolverrCheck.run();
    expect(result.status).toBe('ok');
    expect(result.message).toContain('2/2');
  });

  it('warns naming the dead instance when only some fail', async () => {
    state.settings = settingsWith([], [solverOne, solverTwo]);
    mockGet
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await connectionFlareSolverrCheck.run();
    expect(result.status).toBe('warning');
    expect(result.message).toContain('Byparr');
    expect(result.message).not.toContain("'FlareSolverr'");
  });

  it('errors when every solver is unreachable', async () => {
    state.settings = settingsWith([], [solverOne, solverTwo]);
    mockGet.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await connectionFlareSolverrCheck.run();
    expect(result.status).toBe('error');
    expect(result.message).toContain('FlareSolverr');
    expect(result.message).toContain('Byparr');
  });
});

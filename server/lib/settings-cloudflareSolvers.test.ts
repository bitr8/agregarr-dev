import { describe, expect, it, vi } from 'vitest';
import Settings, { normalizeCloudflareSolvers } from './settings';

const makeSettings = (legacyUrl?: string) => {
  const settings = new Settings();
  const save = vi
    .spyOn(settings, 'save')
    .mockImplementation(() => undefined as never);
  const data = (
    settings as unknown as {
      data: {
        main: {
          flareSolverrUrl?: string;
          cloudflareSolvers?: { id: string; name: string; url: string }[];
        };
        completedMigrations?: string[];
      };
    }
  ).data;
  if (legacyUrl) data.main.flareSolverrUrl = legacyUrl;
  return { settings, save, data };
};

describe('migrateFlareSolverrUrlToSolverList', () => {
  it('seeds the solver list from the legacy URL and deletes the old key', () => {
    const { settings, data } = makeSettings('http://flaresolverr:8191');

    settings.migrateFlareSolverrUrlToSolverList();

    expect(data.main.cloudflareSolvers).toHaveLength(1);
    expect(data.main.cloudflareSolvers?.[0]).toMatchObject({
      name: 'FlareSolverr',
      url: 'http://flaresolverr:8191',
    });
    expect(data.main.cloudflareSolvers?.[0].id).toBeTruthy();
    expect('flareSolverrUrl' in data.main).toBe(false);
    expect(data.completedMigrations).toContain(
      'flaresolverr-url-to-solver-list'
    );
  });

  it('runs only once', () => {
    const { settings, save } = makeSettings('http://flaresolverr:8191');

    settings.migrateFlareSolverrUrlToSolverList();
    settings.migrateFlareSolverrUrlToSolverList();

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('marks complete without seeding when there is no legacy URL', () => {
    const { settings, data } = makeSettings();

    settings.migrateFlareSolverrUrlToSolverList();

    expect(data.main.cloudflareSolvers).toBeUndefined();
    expect(data.completedMigrations).toContain(
      'flaresolverr-url-to-solver-list'
    );
  });

  it('seeds from the legacy URL when the existing list has no usable entry', () => {
    const { settings, data } = makeSettings('http://flaresolverr:8191');
    data.main.cloudflareSolvers = [{ id: 'draft', name: '', url: '' }];

    settings.migrateFlareSolverrUrlToSolverList();

    expect(data.main.cloudflareSolvers).toHaveLength(1);
    expect(data.main.cloudflareSolvers?.[0].url).toBe(
      'http://flaresolverr:8191'
    );
  });

  it('keeps an existing solver list over the legacy URL', () => {
    const { settings, data } = makeSettings('http://old:8191');
    data.main.cloudflareSolvers = [
      { id: 'x', name: 'Byparr', url: 'http://byparr:8191' },
    ];

    settings.migrateFlareSolverrUrlToSolverList();

    expect(data.main.cloudflareSolvers).toHaveLength(1);
    expect(data.main.cloudflareSolvers?.[0].url).toBe('http://byparr:8191');
    expect('flareSolverrUrl' in data.main).toBe(false);
  });
});

describe('normalizeCloudflareSolvers', () => {
  it('rejects non-arrays', () => {
    expect(normalizeCloudflareSolvers('http://x:8191')).toBeNull();
    expect(normalizeCloudflareSolvers({ url: 'http://x:8191' })).toBeNull();
    expect(normalizeCloudflareSolvers(undefined)).toBeNull();
  });

  it('rejects non-object entries', () => {
    expect(normalizeCloudflareSolvers(['http://x:8191'])).toBeNull();
    expect(normalizeCloudflareSolvers([null])).toBeNull();
  });

  it('drops rows without a URL and trims fields', () => {
    const result = normalizeCloudflareSolvers([
      { id: 'a', name: '  FlareSolverr  ', url: '  http://fs:8191  ' },
      { id: 'b', name: 'Empty', url: '   ' },
      { id: 'c', name: 'NoUrl' },
    ]);
    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({
      id: 'a',
      name: 'FlareSolverr',
      url: 'http://fs:8191',
    });
  });

  it('generates an id when missing and keeps a provided one', () => {
    const result = normalizeCloudflareSolvers([
      { name: 'A', url: 'http://a:8191' },
      { id: 'keep-me', name: 'B', url: 'http://b:8191' },
    ]);
    expect(result?.[0].id).toBeTruthy();
    expect(result?.[1].id).toBe('keep-me');
  });

  it('regenerates duplicate ids', () => {
    const result = normalizeCloudflareSolvers([
      { id: 'dup', name: 'A', url: 'http://a:8191' },
      { id: 'dup', name: 'B', url: 'http://b:8191' },
    ]);
    expect(result?.[0].id).toBe('dup');
    expect(result?.[1].id).not.toBe('dup');
    expect(result?.[1].id).toBeTruthy();
  });

  it('returns exactly the posted rows — replacement, not merge', () => {
    const result = normalizeCloudflareSolvers([
      { id: 'only', name: 'Solo', url: 'http://solo:8191' },
    ]);
    expect(result).toHaveLength(1);
  });
});

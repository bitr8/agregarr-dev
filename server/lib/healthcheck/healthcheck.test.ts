import { getJobRuns, recordRun } from '@server/job/schedule';
import { getSettings } from '@server/lib/settings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- recordRun tests ---

describe('recordRun', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records success with duration when callback resolves', async () => {
    const fn = recordRun('plex-refresh-token' as any, async () => {
      return undefined;
    });
    await fn();
    const runs = getJobRuns('plex-refresh-token' as any);
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe('success');
    expect(runs[0].finishedAt).toBeTruthy();
    expect(runs[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records error with message when callback rejects', async () => {
    const fn = recordRun('plex-refresh-token' as any, async () => {
      throw new Error('test failure');
    });
    await fn();
    const runs = getJobRuns('plex-refresh-token' as any);
    expect(runs[0].outcome).toBe('error');
    expect(runs[0].error).toBe('test failure');
  });

  it('records skipped when callback returns skipped', async () => {
    const fn = recordRun('plex-refresh-token' as any, async () => {
      return 'skipped' as const;
    });
    await fn();
    const runs = getJobRuns('plex-refresh-token' as any);
    expect(runs[0].outcome).toBe('skipped');
  });

  it('classifies contention throw as skipped', async () => {
    const fn = recordRun('plex-collections-sync' as any, async () => {
      throw new Error(
        'Discovery is currently running. Please wait for discovery to complete before starting sync.'
      );
    });
    await fn();
    const runs = getJobRuns('plex-collections-sync' as any);
    expect(runs[0].outcome).toBe('skipped');
    expect(runs[0].error).toContain('another job is running');
  });

  it('never rethrows — swallows all errors', async () => {
    const fn = recordRun('plex-refresh-token' as any, async () => {
      throw new Error('catastrophic');
    });
    // Should not throw
    await expect(fn()).resolves.toBeUndefined();
  });

  it('records success for undefined return (internal skip guard, C3)', async () => {
    const fn = recordRun('overlay-application' as any, async () => {
      return undefined;
    });
    await fn();
    const runs = getJobRuns('overlay-application' as any);
    expect(runs[0].outcome).toBe('success');
  });

  it('trims history to MAX_RUN_HISTORY', async () => {
    const fn = recordRun('plex-refresh-token' as any, async () => undefined);
    for (let i = 0; i < 15; i++) {
      await fn();
    }
    const runs = getJobRuns('plex-refresh-token' as any);
    expect(runs.length).toBeLessThanOrEqual(10);
  });

  it('getJobRuns returns newest-first', async () => {
    const fn = recordRun('watchlist-sync' as any, async () => undefined);
    await fn();
    await fn();
    const runs = getJobRuns('watchlist-sync' as any);
    expect(runs.length).toBe(2);
    expect(new Date(runs[0].startedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(runs[1].startedAt).getTime()
    );
  });

  it('getJobRuns returns empty array for unknown job id', () => {
    const runs = getJobRuns('nonexistent-job' as any);
    expect(runs).toEqual([]);
  });

  it('concurrent invocations each create their own record', async () => {
    let resolveFirst: (() => void) | undefined;
    let callCount = 0;
    const fn = recordRun('overlay-quick-sync' as any, async () => {
      callCount++;
      if (callCount === 1) {
        await new Promise<void>((r) => {
          resolveFirst = r;
        });
      }
    });
    const p1 = fn();
    const p2 = fn();
    resolveFirst?.();
    await Promise.all([p1, p2]);
    const runs = getJobRuns('overlay-quick-sync' as any);
    expect(runs.length).toBe(2);
  });

  it('stays running past the old 2h watchdog window (no watchdog anymore)', async () => {
    let resolveJob: (() => void) | undefined;
    const fn = recordRun('plex-collections-sync' as any, () => {
      return new Promise<void>((r) => {
        resolveJob = r;
      });
    });
    const runPromise = fn();
    await vi.advanceTimersByTimeAsync(7_200_000);
    const runs = getJobRuns('plex-collections-sync' as any);
    expect(runs[0].outcome).toBe('running');
    expect(runs[0].finishedAt).toBeNull();
    resolveJob?.();
    await runPromise;
  });
});

// --- jobFreshnessCheck tests ---

describe('jobFreshnessCheck', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    getSettings().plex.collectionConfigs = [{} as any];
  });
  afterEach(() => {
    getSettings().plex.collectionConfigs = [];
    vi.useRealTimers();
  });

  it('reports the last finished error even while a fresh retry is running (a retry does not supersede a failure)', async () => {
    const { jobFreshnessCheck } = await import('@server/lib/healthcheck');
    const failFn = recordRun('plex-collections-sync' as any, async () => {
      throw new Error('boom');
    });
    await failFn();

    let resolveJob: (() => void) | undefined;
    const pendingFn = recordRun('plex-collections-sync' as any, () => {
      return new Promise<void>((r) => {
        resolveJob = r;
      });
    });
    const runPromise = pendingFn();

    const result = await jobFreshnessCheck.run();
    expect(result.status).toBe('warning');
    expect(result.message).toContain('Collections Sync: last run failed: boom');

    resolveJob?.();
    await runPromise;
  });

  it('detects a long-running job even when a fresher skipped run sits on top of it', async () => {
    const { jobFreshnessCheck } = await import('@server/lib/healthcheck');
    const pendingFn = recordRun('plex-collections-sync' as any, () => {
      return new Promise<void>(() => {
        // never resolves — the hung invocation
      });
    });
    void pendingFn(); // started at T0

    vi.setSystemTime(new Date('2026-01-01T01:00:00.000Z')); // T0 + 1h
    const skippedFn = recordRun('plex-collections-sync' as any, async () => {
      throw new Error(
        'Discovery is currently running. Please wait for discovery to complete before starting sync.'
      );
    });
    await skippedFn(); // fresh skip, unshifted on top of the running record

    vi.setSystemTime(new Date('2026-01-02T01:00:00.000Z')); // T0 + 25h

    const runs = getJobRuns('plex-collections-sync' as any);
    expect(runs[0].outcome).toBe('skipped');
    expect(runs[1].outcome).toBe('running');

    const result = await jobFreshnessCheck.run();
    expect(result.status).toBe('warning');
    expect(result.message).toContain(
      'Collections Sync: still running after 25h'
    );
  });

  it('reports still-running once a run exceeds the job maxAgeHours with no finished run', async () => {
    const { jobFreshnessCheck } = await import('@server/lib/healthcheck');
    const pendingFn = recordRun('plex-collections-sync' as any, () => {
      return new Promise<void>(() => {
        // never resolves
      });
    });
    void pendingFn();

    vi.setSystemTime(new Date('2026-01-02T01:00:00.000Z')); // +25h, past the 24h maxAge

    const result = await jobFreshnessCheck.run();
    expect(result.status).toBe('warning');
    expect(result.message).toContain(
      'Collections Sync: still running after 25h'
    );
  });

  it('still warns on a stale success behind a fresh running run and a skipped run', async () => {
    const { jobFreshnessCheck } = await import('@server/lib/healthcheck');
    const okFn = recordRun(
      'plex-collections-sync' as any,
      async () => undefined
    );
    await okFn(); // success at T0

    vi.setSystemTime(new Date('2026-01-02T23:00:00.000Z')); // T0 + 47h
    const skippedFn = recordRun('plex-collections-sync' as any, async () => {
      throw new Error(
        'Discovery is currently running. Please wait for discovery to complete before starting sync.'
      );
    });
    await skippedFn();

    vi.setSystemTime(new Date('2026-01-03T00:00:00.000Z')); // T0 + 48h
    const pendingFn = recordRun('plex-collections-sync' as any, () => {
      return new Promise<void>(() => {
        // still running, only 1h old at check time
      });
    });
    void pendingFn();

    vi.setSystemTime(new Date('2026-01-03T01:00:00.000Z')); // T0 + 49h

    const runs = getJobRuns('plex-collections-sync' as any);
    expect(runs[0].outcome).toBe('running');
    expect(runs[1].outcome).toBe('skipped');
    expect(runs[2].outcome).toBe('success');

    const result = await jobFreshnessCheck.run();
    expect(result.status).toBe('warning');
    expect(result.message).toContain('Collections Sync: last success 49h ago');
  });

  it("matches the reporter's case: a long-running sync with a fresh prior success is ok", async () => {
    const { jobFreshnessCheck } = await import('@server/lib/healthcheck');
    const okFn = recordRun(
      'plex-collections-sync' as any,
      async () => undefined
    );
    await okFn(); // success at T0

    const pendingFn = recordRun('plex-collections-sync' as any, () => {
      return new Promise<void>(() => {
        // still running
      });
    });
    void pendingFn();

    vi.setSystemTime(new Date('2026-01-01T10:30:00.000Z')); // +10.5h — matches the reporter's 10h35m sync

    const result = await jobFreshnessCheck.run();
    expect(result.status).toBe('ok');
  });

  it('reports the failure of the latest finished run', async () => {
    const { jobFreshnessCheck } = await import('@server/lib/healthcheck');
    const failFn = recordRun('plex-collections-sync' as any, async () => {
      throw new Error('boom');
    });
    await failFn();

    const result = await jobFreshnessCheck.run();
    expect(result.status).toBe('warning');
    expect(result.message).toContain('Collections Sync: last run failed');
  });

  it('still flags a stale last success while a new run is in progress (hung job caught)', async () => {
    const { jobFreshnessCheck } = await import('@server/lib/healthcheck');
    const okFn = recordRun(
      'plex-collections-sync' as any,
      async () => undefined
    );
    await okFn();

    vi.setSystemTime(new Date('2026-01-03T01:00:00.000Z')); // +49h, past the 24h maxAge

    let resolveJob: (() => void) | undefined;
    const pendingFn = recordRun('plex-collections-sync' as any, () => {
      return new Promise<void>((r) => {
        resolveJob = r;
      });
    });
    const runPromise = pendingFn();

    const result = await jobFreshnessCheck.run();
    expect(result.status).toBe('warning');
    expect(result.message).toContain('Collections Sync: last success');

    resolveJob?.();
    await runPromise;
  });
});

// --- getHealthStatus aggregation tests (mocked) ---

// These tests verify the pure aggregation logic. Individual check logic
// is tested via the checks themselves on a live system (§N6 in the plan).

describe('getHealthStatus aggregation', () => {
  // We test the exported function's behaviour indirectly through the module.
  // Full integration tests run on nostromo per §N6.

  it('module exports exist', async () => {
    const mod = await import('@server/lib/healthcheck');
    expect(typeof mod.runHealthChecks).toBe('function');
    expect(typeof mod.getHealthStatus).toBe('function');
    expect(typeof mod.healthCheckRunning).toBe('function');
    expect(typeof mod.getCheckIds).toBe('function');
  });

  it('getCheckIds returns all registered check ids', async () => {
    const { getCheckIds } = await import('@server/lib/healthcheck');
    const ids = getCheckIds();
    expect(ids).toContain('connection:plex');
    expect(ids).toContain('plex-version');
    expect(ids).toContain('connection:sonarr');
    expect(ids).toContain('connection:radarr');
    expect(ids).toContain('connection:tmdb');
    expect(ids).toContain('connection:ratings-proxy');
    expect(ids).toContain('connection:flaresolverr');
    expect(ids).toContain('flaresolverr-required');
    expect(ids).toContain('letterboxd-cloudflare');
    expect(ids).toContain('connection:maintainerr');
    expect(ids).toContain('seerr-placeholder-patterns');
    expect(ids).toContain('orphaned-collection-keys');
    expect(ids).toContain('plex-libraries');
    expect(ids).toContain('overlay-template-refs');
    expect(ids).toContain('appdata-writable');
    expect(ids).toContain('placeholder-root-volume');
    expect(ids).toContain('timezone-configuration');
    expect(ids).toContain('job-freshness');
    expect(ids).toHaveLength(18);
  });
});

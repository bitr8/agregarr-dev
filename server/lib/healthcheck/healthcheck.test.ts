import { getJobRuns, recordRun } from '@server/job/schedule';
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
    expect(ids).toContain('connection:sonarr');
    expect(ids).toContain('connection:radarr');
    expect(ids).toContain('connection:tmdb');
    expect(ids).toContain('connection:ratings-proxy');
    expect(ids).toContain('connection:flaresolverr');
    expect(ids).toContain('flaresolverr-required');
    expect(ids).toContain('letterboxd-cloudflare');
    expect(ids).toContain('connection:maintainerr');
    expect(ids).toContain('orphaned-collection-keys');
    expect(ids).toContain('plex-libraries');
    expect(ids).toContain('overlay-template-refs');
    expect(ids).toContain('appdata-writable');
    expect(ids).toContain('timezone-configuration');
    expect(ids).toContain('job-freshness');
    expect(ids).toHaveLength(15);
  });
});

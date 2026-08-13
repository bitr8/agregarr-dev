// Availability sync import removed - not needed for collections-only app
import { getRepository } from '@server/datasource';
import { JobRunHistory } from '@server/entity/JobRunHistory';
import collectionsQuickSync from '@server/lib/collectionsQuickSync';
import collectionsSync from '@server/lib/collectionsSync';
import { healthCheckRunning, runHealthChecks } from '@server/lib/healthcheck';
// ImageProxy removed - not needed for collections-only app
import overlayApplication from '@server/lib/overlayApplication';
import overlaysQuickSync from '@server/lib/overlaysQuickSync';
import randomizeHomeOrder from '@server/lib/randomizeHomeOrder';
import refreshToken from '@server/lib/refreshToken';
import watchlistSync from '@server/lib/watchlistSync';
// Scanner imports removed - not needed for collections-only app
import type { JobId } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import schedule from 'node-schedule';

export interface JobRunRecord {
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  outcome: 'success' | 'error' | 'skipped' | 'running';
  error?: string;
}

interface ScheduledJob {
  id: JobId;
  job: schedule.Job;
  name: string;
  type: 'process' | 'command';
  interval: 'seconds' | 'minutes' | 'hours' | 'fixed';
  cronSchedule: string;
  running?: () => boolean;
  cancelFn?: () => void;
}

const MAX_RUN_HISTORY = 10;
const LONG_RUNNING_JOBS: ReadonlySet<string> = new Set([
  'plex-collections-sync',
  'overlay-application',
]);
const WATCHDOG_SHORT_MS = 300_000; // 5min for quick jobs
const WATCHDOG_LONG_MS = 7_200_000; // 2h for full sync/overlay
const jobRuns = new Map<JobId, JobRunRecord[]>();

export const getJobRuns = (id: JobId): JobRunRecord[] => jobRuns.get(id) ?? [];

const MAX_PERSISTED_PER_JOB = 50;

async function getJobDetail(
  jobId: JobId,
  runStartedAt?: string
): Promise<Record<string, unknown> | null> {
  try {
    switch (jobId) {
      case 'plex-collections-sync': {
        const { default: progress } = await import(
          '@server/lib/collections/CollectionSyncProgress'
        );
        const last = progress.getLastCompleted();
        if (!last) return null;
        return {
          successCount: last.successCount,
          errorCount: last.errorCount,
          skippedCount: last.skippedCount,
          createdCount: last.createdCount,
          updatedCount: last.updatedCount,
          outcomes: last.recentOutcomes,
        };
      }
      case 'overlay-application': {
        const { overlayLibraryService } = await import(
          '@server/lib/overlays/OverlayLibraryService'
        );
        const allLibs = overlayLibraryService.getLastCompletedLibraries();
        const runStart = runStartedAt ? new Date(runStartedAt).getTime() : 0;
        const libs = allLibs.filter((l) => l.startTime >= runStart);
        if (libs.length === 0) return null;
        return {
          libraries: libs.map((l) => ({
            libraryId: l.libraryId,
            libraryName: l.libraryName,
            successCount: l.successCount,
            errorCount: l.errorCount,
            skippedCount: l.skippedCount,
            itemErrors: l.itemErrors,
          })),
        };
      }
      case 'plex-collections-quick-sync':
        return collectionsQuickSync.lastCompletedSummary as Record<
          string,
          unknown
        > | null;
      case 'overlay-quick-sync':
        return overlaysQuickSync.lastCompletedSummary as Record<
          string,
          unknown
        > | null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

async function persistJobRun(id: JobId, rec: JobRunRecord): Promise<void> {
  try {
    const repo = getRepository(JobRunHistory);
    const detail = await getJobDetail(id, rec.startedAt);

    const row = new JobRunHistory();
    row.jobId = id;
    row.startedAt = rec.startedAt;
    row.finishedAt = rec.finishedAt;
    row.durationMs = rec.durationMs;
    row.outcome = rec.outcome;
    row.error = rec.error ?? null;
    row.detail = detail;
    await repo.save(row);

    await repo.query(
      `DELETE FROM job_run_history WHERE jobId = ? AND id NOT IN (SELECT id FROM job_run_history WHERE jobId = ? ORDER BY id DESC LIMIT ?)`,
      [id, id, MAX_PERSISTED_PER_JOB]
    );
  } catch (err) {
    logger.warn('Failed to persist job run', {
      label: 'Jobs',
      jobId: id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function hydrateJobRuns(): Promise<void> {
  try {
    const repo = getRepository(JobRunHistory);
    const rows = await repo.find({
      order: { startedAt: 'DESC' },
      take: MAX_RUN_HISTORY * 10,
    });

    const byJob = new Map<string, JobRunRecord[]>();
    for (const row of rows) {
      const list = byJob.get(row.jobId) ?? [];
      if (list.length >= MAX_RUN_HISTORY) continue;
      list.push({
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        durationMs: row.durationMs,
        outcome: row.outcome as JobRunRecord['outcome'],
        error: row.error ?? undefined,
      });
      byJob.set(row.jobId, list);
    }
    for (const [jobId, list] of byJob) {
      jobRuns.set(jobId as JobId, list);
    }
    logger.info(`Hydrated ${byJob.size} jobs from database`, {
      label: 'Jobs',
    });
  } catch (err) {
    logger.warn('Failed to hydrate job runs', {
      label: 'Jobs',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const isContentionError = (err: unknown): boolean => {
  const msg =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /currently running.*(?:wait|complete)/i.test(msg);
};

export const recordRun = (
  id: JobId,
  fn: () => Promise<unknown>
): (() => Promise<void>) => {
  return async () => {
    const rec: JobRunRecord = {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      outcome: 'running',
    };
    const list = jobRuns.get(id) ?? [];
    list.unshift(rec);
    jobRuns.set(id, list);

    const start = Date.now();
    const timeoutMs = LONG_RUNNING_JOBS.has(id)
      ? WATCHDOG_LONG_MS
      : WATCHDOG_SHORT_MS;
    const watchdog = setTimeout(() => {
      if (rec.outcome === 'running') {
        rec.outcome = 'error';
        rec.error = `Job did not complete within ${Math.round(
          timeoutMs / 60_000
        )} minutes`;
        rec.finishedAt = new Date().toISOString();
        rec.durationMs = Date.now() - start;
      }
    }, timeoutMs);

    try {
      const result = await fn();
      rec.outcome = result === 'skipped' ? 'skipped' : 'success';
      rec.error = undefined;
    } catch (err) {
      if (isContentionError(err)) {
        rec.outcome = 'skipped';
        rec.error = 'Skipped — another job is running';
      } else {
        rec.outcome = 'error';
        rec.error =
          err instanceof Error
            ? err.message.slice(0, 200)
            : String(err).slice(0, 200);
      }
    } finally {
      clearTimeout(watchdog);
      if (rec.outcome === 'running') rec.outcome = 'success';
      rec.finishedAt = new Date().toISOString();
      rec.durationMs = Date.now() - start;
      if (list.length > MAX_RUN_HISTORY) list.length = MAX_RUN_HISTORY;
      void persistJobRun(id, rec);
    }
  };
};

export const scheduledJobs: ScheduledJob[] = [];

export const startJobs = (): void => {
  const jobs = getSettings().jobs;

  // Plex Recently Added Scan removed - not needed for collections-only app

  // Plex Full Library Scan removed - not needed for collections-only app

  // Radarr Scan removed - not needed for collections-only app

  // Sonarr Scan removed - not needed for collections-only app

  // Media Availability Sync removed - not needed for collections-only app

  scheduledJobs.push({
    id: 'plex-collections-sync',
    name: 'Plex Collections Sync',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['plex-collections-sync'].schedule,
    job: schedule.scheduleJob(
      jobs['plex-collections-sync'].schedule,
      recordRun('plex-collections-sync', async () => {
        const settings = getSettings();
        const hasCollections =
          settings.plex.collectionConfigs &&
          settings.plex.collectionConfigs.length > 0;

        if (!hasCollections) {
          logger.debug(
            'Skipping scheduled Plex Collections Sync: No collections configured',
            { label: 'Jobs' }
          );
          return 'skipped' as const;
        }

        logger.info('Starting scheduled job: Plex Collections Sync', {
          label: 'Jobs',
        });
        return collectionsSync.run();
      })
    ),
    running: () => collectionsSync.status.running,
    cancelFn: () => collectionsSync.cancel(),
  });

  scheduledJobs.push({
    id: 'plex-collections-quick-sync',
    name: 'Collections Quick Sync',
    type: 'process',
    interval: 'minutes',
    cronSchedule: jobs['plex-collections-quick-sync'].schedule,
    job: schedule.scheduleJob(
      jobs['plex-collections-quick-sync'].schedule,
      recordRun('plex-collections-quick-sync', async () => {
        logger.info('Starting scheduled job: Collections Quick Sync', {
          label: 'Jobs',
        });
        return collectionsQuickSync.run();
      })
    ),
    running: () => collectionsQuickSync.status.running,
    cancelFn: () => collectionsQuickSync.cancel(),
  });

  scheduledJobs.push({
    id: 'plex-randomize-home-order',
    name: 'Plex Randomize Home Order',
    type: 'process',
    interval: 'minutes',
    cronSchedule: jobs['plex-randomize-home-order'].schedule,
    job: schedule.scheduleJob(
      jobs['plex-randomize-home-order'].schedule,
      recordRun('plex-randomize-home-order', async () => {
        logger.info('Starting scheduled job: Plex Randomize Home Order', {
          label: 'Jobs',
        });
        return randomizeHomeOrder.run();
      })
    ),
    running: () => randomizeHomeOrder.status.running,
    cancelFn: () => randomizeHomeOrder.cancel(),
  });

  scheduledJobs.push({
    id: 'overlay-application',
    name: 'Overlay Application',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['overlay-application'].schedule,
    job: schedule.scheduleJob(
      jobs['overlay-application'].schedule,
      recordRun('overlay-application', async () => {
        logger.info('Starting scheduled job: Overlay Application', {
          label: 'Jobs',
        });
        return overlayApplication.run();
      })
    ),
    running: () => overlayApplication.status.running,
    cancelFn: () => overlayApplication.cancel(),
  });

  scheduledJobs.push({
    id: 'overlay-quick-sync',
    name: 'Overlay Quick Sync',
    type: 'process',
    interval: 'minutes',
    cronSchedule: jobs['overlay-quick-sync'].schedule,
    job: schedule.scheduleJob(
      jobs['overlay-quick-sync'].schedule,
      recordRun('overlay-quick-sync', async () => {
        logger.info('Starting scheduled job: Overlay Quick Sync', {
          label: 'Jobs',
        });
        return overlaysQuickSync.run();
      })
    ),
    running: () => overlaysQuickSync.status.running,
    cancelFn: () => overlaysQuickSync.cancel(),
  });

  scheduledJobs.push({
    id: 'plex-refresh-token',
    name: 'Plex Refresh Token',
    type: 'process',
    interval: 'fixed',
    cronSchedule: jobs['plex-refresh-token'].schedule,
    job: schedule.scheduleJob(
      jobs['plex-refresh-token'].schedule,
      recordRun('plex-refresh-token', async () => {
        logger.info('Starting scheduled job: Plex Refresh Token', {
          label: 'Jobs',
        });
        return refreshToken.run();
      })
    ),
  });

  scheduledJobs.push({
    id: 'watchlist-sync',
    name: 'Plex Watchlist Sync',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['watchlist-sync'].schedule,
    job: schedule.scheduleJob(
      jobs['watchlist-sync'].schedule,
      recordRun('watchlist-sync', async () => {
        const settings = getSettings();
        const syncSettings = settings.watchlistSync;

        if (!syncSettings.enableOwner && !syncSettings.enableUsers) {
          logger.debug('Skipping scheduled Watchlist Sync: Not enabled', {
            label: 'Jobs',
          });
          return 'skipped' as const;
        }

        logger.info('Starting scheduled job: Plex Watchlist Sync', {
          label: 'Jobs',
        });
        return watchlistSync.run();
      })
    ),
    running: () => watchlistSync.status.running,
    cancelFn: () => watchlistSync.cancel(),
  });

  const healthCheckSchedule = jobs['health-checks'].schedule;
  scheduledJobs.push({
    id: 'health-checks',
    name: 'Health Checks',
    type: 'command',
    interval: 'hours',
    cronSchedule: healthCheckSchedule,
    job: schedule.scheduleJob(
      healthCheckSchedule,
      recordRun('health-checks', async () => {
        if (getSettings().main.healthChecksEnabled === false)
          return 'skipped' as const;
        return runHealthChecks();
      })
    ),
    running: healthCheckRunning,
  });

  // Startup sweep — run initial health check after 60s to avoid startup contention
  setTimeout(() => {
    const settings = getSettings();
    if (settings.main.healthChecksEnabled !== false) {
      runHealthChecks();
    }
  }, 60_000);

  logger.info('Scheduled jobs loaded', { label: 'Jobs' });
};

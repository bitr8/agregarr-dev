// Availability sync import removed - not needed for collections-only app
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
const WATCHDOG_TIMEOUT_MS = 300_000;
const jobRuns = new Map<JobId, JobRunRecord[]>();

export const getJobRuns = (id: JobId): JobRunRecord[] => jobRuns.get(id) ?? [];

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
    const watchdog = setTimeout(() => {
      if (rec.outcome === 'running') {
        rec.outcome = 'error';
        rec.error = 'Job did not complete within 5 minutes';
        rec.finishedAt = new Date().toISOString();
        rec.durationMs = Date.now() - start;
      }
    }, WATCHDOG_TIMEOUT_MS);

    try {
      const result = await fn();
      if (rec.outcome !== 'running') return;
      rec.outcome = result === 'skipped' ? 'skipped' : 'success';
    } catch (err) {
      if (rec.outcome !== 'running') return;
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
      rec.finishedAt ??= new Date().toISOString();
      rec.durationMs ??= Date.now() - start;
      if (list.length > MAX_RUN_HISTORY) list.length = MAX_RUN_HISTORY;
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

import PlexAPI from '@server/api/plexapi';
import type { PlexMetadataSafeResult } from '@server/api/plexMetadataClassify';
import { classifyCollectionKey } from '@server/api/plexMetadataClassify';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { getRepository } from '@server/datasource';
import { OverlayLibraryConfig } from '@server/entity/OverlayLibraryConfig';
import { OverlayTemplate } from '@server/entity/OverlayTemplate';
import { getAdminUser } from '@server/lib/collections/core/CollectionUtilities';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { appDataPath } from '@server/utils/appDataVolume';
import { scrubSecrets } from '@server/utils/logRedaction';
import axios from 'axios';
import { accessSync, constants, unlinkSync, writeFileSync } from 'fs';
import path from 'path';

type HealthCheckStatus = 'ok' | 'warning' | 'error' | 'skipped';

export interface HealthCheck {
  id: string;
  name: string;
  run: () => Promise<{ status: HealthCheckStatus; message?: string }>;
}

export interface HealthCheckResult {
  id: string;
  name: string;
  status: HealthCheckStatus;
  message?: string;
  durationMs: number;
  checkedAt: string;
}

export interface HealthStatusResponse {
  status: 'ok' | 'warning' | 'error' | 'unknown' | 'disabled';
  checkedAt: string | null;
  checks: (HealthCheckResult & { silenced: boolean })[];
}

const CHECK_TIMEOUT_MS = 10_000;

const results = new Map<string, HealthCheckResult>();
let lastRunAt: string | null = null;
let running = false;

export const healthCheckRunning = () => running;

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Health check timed out after ${ms}ms`)),
        ms
      )
    ),
  ]);

const sanitize = (msg: string): string => scrubSecrets(msg).slice(0, 200);

// Capture native DateTimeFormat before the SSR polyfill replaces global Intl
const NativeDateTimeFormat = Intl.DateTimeFormat;

// Track consecutive failures per check for transient-tolerance
const failureCounts = new Map<string, number>();

// --- Individual checks ---

const connectionPlexCheck: HealthCheck = {
  id: 'connection:plex',
  name: 'Plex Connection',

  run: async () => {
    const settings = getSettings();
    if (!settings.plex.ip) return { status: 'skipped' };

    const admin = await getAdminUser();
    if (!admin?.plexToken) {
      return { status: 'error', message: 'No Plex admin user configured' };
    }

    try {
      const plex = new PlexAPI({ plexToken: admin.plexToken });
      const status = await plex.getStatus();
      const mc = status?.MediaContainer;
      const name = mc?.friendlyName;
      const version = mc?.version;
      return {
        status: 'ok',
        message: name
          ? `Connected to ${name}${version ? ` (v${version})` : ''}`
          : undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      let hint = '';
      if (msg.includes('ECONNREFUSED'))
        hint = ' — check IP address and that Plex is running';
      else if (msg.includes('ETIMEDOUT') || msg.includes('EHOSTUNREACH'))
        hint = ' — check network/firewall between containers';
      else if (msg.includes('401') || msg.includes('Unauthorized'))
        hint = ' — Plex token may be expired, try re-authenticating';
      else if (msg.includes('certificate') || msg.includes('SSL'))
        hint = ' — SSL mismatch, check "Use SSL" setting matches Plex config';
      return {
        status: 'error',
        message: sanitize(`Plex unreachable${hint}: ${msg}`),
      };
    }
  },
};

const buildConnectionArrCheck = (
  service: 'sonarr' | 'radarr'
): HealthCheck => ({
  id: `connection:${service}`,
  name: `${service[0].toUpperCase()}${service.slice(1)} Connection`,

  run: async () => {
    const settings = getSettings();
    const instances =
      service === 'sonarr'
        ? settings.sonarr.filter((i) => i.syncEnabled !== false)
        : settings.radarr.filter((i) => i.syncEnabled !== false);
    if (!instances.length) return { status: 'skipped' };

    const failures: string[] = [];
    for (const inst of instances) {
      try {
        const ApiClass = service === 'sonarr' ? SonarrAPI : RadarrAPI;
        const api = new ApiClass({
          apiKey: inst.apiKey,
          url: ApiClass.buildUrl(inst, '/api/v3'),
        });
        await api.getSystemStatus();
      } catch (err) {
        const baseUrl = `${inst.useSsl ? 'https' : 'http'}://${inst.hostname}:${
          inst.port
        }`;
        failures.push(
          sanitize(
            `'${inst.name}' (${baseUrl}) unreachable: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        );
      }
    }

    if (!failures.length) {
      return {
        status: 'ok',
        message: `${instances.length}/${
          instances.length
        } ${service[0].toUpperCase()}${service.slice(1)} instance${
          instances.length === 1 ? '' : 's'
        } reachable`,
      };
    }
    return {
      status: failures.length === instances.length ? 'error' : 'warning',
      message: failures.join('; '),
    };
  },
});

const connectionTmdbCheck: HealthCheck = {
  id: 'connection:tmdb',
  name: 'TMDB Connection',

  run: async () => {
    try {
      const res = await fetch(
        'https://api.themoviedb.org/3/configuration?api_key=74fc2350fc03cafb0ca5bffbff32e3b5',
        { signal: AbortSignal.timeout(5000) }
      );
      if (!res.ok) throw new Error(`TMDB returned ${res.status}`);
      return { status: 'ok' };
    } catch (err) {
      return {
        status: 'warning',
        message: sanitize(
          `TMDB unreachable: ${
            err instanceof Error ? err.message : String(err)
          }`
        ),
      };
    }
  },
};

const connectionRatingsProxyCheck: HealthCheck = {
  id: 'connection:ratings-proxy',
  name: 'Ratings Proxy',

  run: async () => {
    try {
      const res = await fetch('https://api.agregarr.org', {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Ratings proxy returned ${res.status}`);
      const body = (await res.json()) as Record<string, unknown>;
      if (!body.name) throw new Error('Unexpected response from ratings proxy');
      return { status: 'ok' };
    } catch (err) {
      return {
        status: 'warning',
        message: sanitize(
          `Ratings proxy unreachable: ${
            err instanceof Error ? err.message : String(err)
          }`
        ),
      };
    }
  },
};

export const connectionFlareSolverrCheck: HealthCheck = {
  id: 'connection:flaresolverr',
  name: 'Cloudflare Solver Connection',

  run: async () => {
    const solvers = (getSettings().main.cloudflareSolvers ?? []).filter(
      (s) => s?.url
    );
    if (!solvers.length) return { status: 'skipped' };

    // Parallel: sequential 5s probes of dead solvers would trip the
    // 10s runner timeout and lose the per-instance message
    const probes = await Promise.allSettled(
      solvers.map((solver) =>
        axios.get(solver.url.replace(/\/+$/, ''), { timeout: 5000 })
      )
    );
    const failures: string[] = [];
    probes.forEach((probe, i) => {
      if (probe.status === 'rejected') {
        const solver = solvers[i];
        const err = probe.reason;
        failures.push(
          sanitize(
            `'${solver.name || solver.url}' (${solver.url}) unreachable: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        );
      }
    });

    if (!failures.length) {
      return {
        status: 'ok',
        message: `${solvers.length}/${solvers.length} solver${
          solvers.length === 1 ? '' : 's'
        } reachable`,
      };
    }
    return {
      status: failures.length === solvers.length ? 'error' : 'warning',
      message: failures.join('; '),
    };
  },
};

// Missing-flagged configs still sync (CollectionSyncService filters only filtered_hub),
// so they still require the solver — no missing exclusion here.
export const flareSolverrRequiredCheck: HealthCheck = {
  id: 'flaresolverr-required',
  name: 'Cloudflare Solver',

  run: async () => {
    const { main, plex } = getSettings();
    const usesFlixPatrol = (plex.collectionConfigs ?? []).some(
      (c) =>
        c.type === 'networks' ||
        (c.sources ?? []).some((s) => s.type === 'networks')
    );
    if (!usesFlixPatrol) return { status: 'skipped' };

    if (!main.cloudflareSolvers?.some((s) => s?.url)) {
      return {
        status: 'error',
        message:
          'Networks Top 10 collections fetch from FlixPatrol, which sits behind a Cloudflare challenge the built-in browser cannot reliably pass. Install FlareSolverr or Byparr and add it as a Cloudflare solver in Settings > Sources.',
      };
    }

    return { status: 'ok', message: 'Solver configured' };
  },
};

const connectionMaintainerrCheck: HealthCheck = {
  id: 'connection:maintainerr',
  name: 'Maintainerr Connection',

  run: async () => {
    const maintainerr = getSettings().maintainerr;
    if (!maintainerr?.hostname || !maintainerr?.apiKey) {
      return { status: 'skipped' };
    }

    try {
      const protocol = maintainerr.useSsl ? 'https' : 'http';
      const port = maintainerr.port ? `:${maintainerr.port}` : '';
      const urlBase = maintainerr.urlBase ?? '';
      const baseURL = `${protocol}://${maintainerr.hostname}${port}${urlBase}`;
      const res = await axios.get(`${baseURL}/api/collections`, {
        headers: { 'X-Api-Key': maintainerr.apiKey },
        timeout: 5000,
      });
      if (!Array.isArray(res.data)) {
        return {
          status: 'warning',
          message: sanitize('Unexpected response from Maintainerr API'),
        };
      }
      return { status: 'ok' };
    } catch (err) {
      return {
        status: 'error',
        message: sanitize(
          `Maintainerr unreachable: ${
            err instanceof Error ? err.message : String(err)
          }`
        ),
      };
    }
  },
};

const orphanedCollectionKeysCheck: HealthCheck = {
  id: 'orphaned-collection-keys',
  name: 'Orphaned Collection Keys',

  run: async () => {
    const settings = getSettings();
    const configs = settings.plex.collectionConfigs ?? [];

    interface KeyEntry {
      key: string;
      configName: string;
    }

    const entries: KeyEntry[] = [];
    for (const config of configs) {
      if (config.missing) continue;
      if (config.collectionRatingKey) {
        entries.push({
          key: String(config.collectionRatingKey),
          configName: config.name || `config ${config.id}`,
        });
      }
      if (config.collectionRatingKeys) {
        for (const k of Object.values(config.collectionRatingKeys)) {
          if (k != null) {
            entries.push({
              key: String(k),
              configName: config.name || `config ${config.id}`,
            });
          }
        }
      }
    }

    if (!entries.length) return { status: 'skipped' };

    const admin = await getAdminUser();
    if (!admin?.plexToken) {
      return { status: 'error', message: 'No Plex admin user configured' };
    }

    const plex = new PlexAPI({ plexToken: admin.plexToken });
    const orphaned: string[] = [];

    for (const entry of entries) {
      const result: PlexMetadataSafeResult = await plex.getMetadataSafe(
        entry.key
      );
      if (result.status === 'error') {
        return {
          status: 'error',
          message: 'Plex unreachable — orphan status not assessed',
        };
      }
      const state = classifyCollectionKey(result);
      if (state === 'absent' || state === 'not-a-collection') {
        orphaned.push(entry.configName);
      }
    }

    if (!orphaned.length) return { status: 'ok' };

    const unique = [...new Set(orphaned)];
    const names = unique.slice(0, 5);
    const suffix = unique.length > 5 ? ` and ${unique.length - 5} more` : '';
    return {
      status: 'warning',
      message: `${unique.length} config${unique.length === 1 ? '' : 's'} point${
        unique.length === 1 ? 's' : ''
      } at deleted Plex collections: ${names.join(', ')}${suffix}`,
    };
  },
};

const plexLibrariesCheck: HealthCheck = {
  id: 'plex-libraries',
  name: 'Plex Libraries',

  run: async () => {
    const settings = getSettings();
    if (!settings.plex.ip) return { status: 'skipped' };

    const admin = await getAdminUser();
    if (!admin?.plexToken) return { status: 'skipped' };

    let configuredLibIds: string[];
    try {
      const repo = getRepository(OverlayLibraryConfig);
      const configs = await repo.find();
      const collectionLibIds = (settings.plex.collectionConfigs ?? [])
        .filter((c) => !c.missing)
        .map((c) => String(c.libraryId));
      const overlayLibIds = configs.map((c) => String(c.libraryId));
      configuredLibIds = [...new Set([...collectionLibIds, ...overlayLibIds])];
    } catch (err) {
      return {
        status: 'warning',
        message: sanitize(
          `Could not query overlay configs: ${
            err instanceof Error ? err.message : String(err)
          }`
        ),
      };
    }

    if (!configuredLibIds.length) return { status: 'ok' };

    try {
      const plex = new PlexAPI({ plexToken: admin.plexToken });
      const libs = await plex.getLibraries();
      const plexIds = new Set(libs.map((l) => String(l.key)));
      const missing = configuredLibIds.filter((id) => !plexIds.has(id));

      if (!missing.length) return { status: 'ok' };
      return {
        status: 'warning',
        message: sanitize(
          `${missing.length} configured library ID${
            missing.length === 1 ? '' : 's'
          } not found in Plex: ${missing.join(
            ', '
          )}. Libraries may have been deleted.`
        ),
      };
    } catch (err) {
      return {
        status: 'warning',
        message: sanitize(
          `Could not verify Plex libraries: ${
            err instanceof Error ? err.message : String(err)
          }`
        ),
      };
    }
  },
};

const overlayTemplateRefsCheck: HealthCheck = {
  id: 'overlay-template-refs',
  name: 'Overlay Templates',

  run: async () => {
    let configs: OverlayLibraryConfig[];
    let templates: OverlayTemplate[];
    try {
      configs = await getRepository(OverlayLibraryConfig).find();
      templates = await getRepository(OverlayTemplate).find();
    } catch (err) {
      return {
        status: 'warning',
        message: sanitize(
          `Could not query overlay data: ${
            err instanceof Error ? err.message : String(err)
          }`
        ),
      };
    }

    if (!configs.length) return { status: 'skipped' };

    const templateIds = new Set(templates.map((t) => t.id));
    const broken: string[] = [];

    for (const config of configs) {
      for (const overlay of config.enabledOverlays ?? []) {
        if (overlay.enabled && !templateIds.has(overlay.templateId)) {
          broken.push(
            `library "${config.libraryName}" references missing template #${overlay.templateId}`
          );
        }
      }
    }

    if (!broken.length) return { status: 'ok' };
    const display = broken.slice(0, 3);
    const suffix = broken.length > 3 ? ` (+${broken.length - 3} more)` : '';
    return {
      status: 'warning',
      message: sanitize(`${display.join('; ')}${suffix}`),
    };
  },
};

const appdataWritableCheck: HealthCheck = {
  id: 'appdata-writable',
  name: 'Data Directory',

  run: async () => {
    const base = appDataPath();
    const dirs = [
      { path: base, label: 'config root' },
      { path: path.join(base, 'db'), label: 'db' },
    ];
    const issues: string[] = [];

    for (const dir of dirs) {
      try {
        accessSync(dir.path, constants.W_OK);
      } catch {
        issues.push(dir.label);
      }
    }

    if (!issues.length) {
      const probe = path.join(base, `.health-probe-${process.pid}`);
      try {
        writeFileSync(probe, 'ok');
        unlinkSync(probe);
      } catch {
        issues.push('config root (write test failed)');
      }
    }

    if (!issues.length) return { status: 'ok' };
    return {
      status: 'error',
      message: sanitize(
        `Cannot write to: ${issues.join(
          ', '
        )}. Check container volume mounts and permissions (PUID/PGID).`
      ),
    };
  },
};

const timezoneConfigurationCheck: HealthCheck = {
  id: 'timezone-configuration',
  name: 'Timezone',

  run: async () => {
    const tz = process.env.TZ;

    if (tz) {
      try {
        new NativeDateTimeFormat(undefined, { timeZone: tz });
      } catch {
        return {
          status: 'error',
          message: `TZ environment variable "${tz}" is not a valid timezone. Use a value like "America/New_York" or "Australia/Sydney".`,
        };
      }
    }

    const settings = getSettings();
    const hasSonarr = settings.sonarr.some((s) => s.syncEnabled !== false);
    if (!hasSonarr) return { status: 'ok' };

    if (!tz || tz === 'UTC') {
      return {
        status: 'warning',
        message:
          'Server timezone is UTC with active Sonarr integration. Air-date day boundaries may differ by one day. Set TZ in your container environment.',
      };
    }

    return { status: 'ok' };
  },
};

const jobFreshnessCheck: HealthCheck = {
  id: 'job-freshness',
  name: 'Job Health',

  run: async () => {
    const { getJobRuns } = await import('@server/job/schedule');
    const settings = getSettings();
    const hasCollections = (settings.plex.collectionConfigs ?? []).length > 0;
    if (!hasCollections) return { status: 'skipped' };

    const issues: string[] = [];
    const criticalJobs: { id: string; label: string; maxAgeHours: number }[] = [
      {
        id: 'plex-collections-sync',
        label: 'Collections Sync',
        maxAgeHours: 24,
      },
      {
        id: 'plex-collections-quick-sync',
        label: 'Quick Sync',
        maxAgeHours: 2,
      },
    ];

    for (const job of criticalJobs) {
      const runs = getJobRuns(job.id as Parameters<typeof getJobRuns>[0]);
      if (!runs.length) continue;
      const last = runs[0];
      if (last.outcome === 'error') {
        const err = last.error ? `: ${last.error.slice(0, 40)}` : '';
        issues.push(`${job.label}: last run failed${err}`);
        continue;
      }
      if (last.outcome === 'success' && last.finishedAt) {
        const ageMs = Date.now() - new Date(last.finishedAt).getTime();
        const ageHours = ageMs / (1000 * 60 * 60);
        if (ageHours > job.maxAgeHours) {
          issues.push(
            `${job.label}: last success ${Math.round(
              ageHours
            )}h ago (expected every ${job.maxAgeHours}h)`
          );
        }
      }
    }

    if (!issues.length) return { status: 'ok' };
    return {
      status: 'warning',
      message: sanitize(issues.join('; ')),
    };
  },
};

// --- Registry ---

const checks: HealthCheck[] = [
  connectionPlexCheck,
  buildConnectionArrCheck('sonarr'),
  buildConnectionArrCheck('radarr'),
  connectionTmdbCheck,
  connectionRatingsProxyCheck,
  connectionFlareSolverrCheck,
  flareSolverrRequiredCheck,
  connectionMaintainerrCheck,
  orphanedCollectionKeysCheck,
  plexLibrariesCheck,
  overlayTemplateRefsCheck,
  appdataWritableCheck,
  timezoneConfigurationCheck,
  jobFreshnessCheck,
];

// --- Runner ---

export async function runHealthChecks(): Promise<void> {
  if (running) return;
  running = true;

  try {
    const settings = getSettings();
    // Orphan check gets scaled timeout (H3)
    const configs = settings.plex.collectionConfigs ?? [];
    let orphanKeyCount = 0;
    for (const c of configs) {
      if (c.missing) continue;
      if (c.collectionRatingKey) orphanKeyCount++;
      if (c.collectionRatingKeys) {
        orphanKeyCount += Object.values(c.collectionRatingKeys).filter(
          Boolean
        ).length;
      }
    }
    const orphanTimeout = Math.max(30_000, orphanKeyCount * 500);

    const settled = await Promise.allSettled(
      checks.map(async (check) => {
        const start = Date.now();
        const timeout =
          check.id === 'orphaned-collection-keys'
            ? orphanTimeout
            : CHECK_TIMEOUT_MS;
        try {
          const result = await withTimeout(check.run(), timeout);

          // Transient-tolerance: external checks get warning on first failure, error on consecutive
          if (result.status === 'error' && check.id.startsWith('connection:')) {
            const count = (failureCounts.get(check.id) ?? 0) + 1;
            failureCounts.set(check.id, count);
            const r: HealthCheckResult = {
              id: check.id,
              name: check.name,
              status: count >= 2 ? 'error' : 'warning',
              message: result.message,

              durationMs: Date.now() - start,
              checkedAt: new Date().toISOString(),
            };
            results.set(check.id, r);
          } else {
            if (result.status === 'ok') failureCounts.delete(check.id);
            const r: HealthCheckResult = {
              id: check.id,
              name: check.name,
              status: result.status,
              message: result.message,

              durationMs: Date.now() - start,
              checkedAt: new Date().toISOString(),
            };
            results.set(check.id, r);
          }
        } catch (err) {
          const count = (failureCounts.get(check.id) ?? 0) + 1;
          failureCounts.set(check.id, count);
          results.set(check.id, {
            id: check.id,
            name: check.name,
            status:
              check.id.startsWith('connection:') && count < 2
                ? 'warning'
                : 'error',
            message: sanitize(err instanceof Error ? err.message : String(err)),
            durationMs: Date.now() - start,
            checkedAt: new Date().toISOString(),
          });
        }
      })
    );

    // Log any rejected promises (shouldn't happen, but defensive)
    for (const s of settled) {
      if (s.status === 'rejected') {
        logger.warn(`Health check promise rejected: ${s.reason}`, {
          label: 'HealthCheck',
        });
      }
    }

    lastRunAt = new Date().toISOString();
  } finally {
    running = false;
  }
}

export function getHealthStatus(): HealthStatusResponse {
  const settings = getSettings();
  const { main } = settings;

  if (main.healthChecksEnabled === false) {
    if (results.size > 0) results.clear();
    return { status: 'disabled', checkedAt: null, checks: [] };
  }

  if (!lastRunAt) {
    return { status: 'unknown', checkedAt: null, checks: [] };
  }

  const silenced = new Set(main.silencedHealthChecks ?? []);

  const checkResults = checks.map((check) => {
    const r = results.get(check.id);
    return {
      id: check.id,
      name: check.name,
      status: (r?.status ?? 'skipped') as HealthCheckStatus,
      message: r?.message,
      durationMs: r?.durationMs ?? 0,
      checkedAt: r?.checkedAt ?? lastRunAt ?? '',
      silenced: silenced.has(check.id),
    };
  });

  const nonSilenced = checkResults.filter((c) => !c.silenced);
  let overallStatus: HealthStatusResponse['status'] = 'ok';
  for (const c of nonSilenced) {
    if (c.status === 'error') {
      overallStatus = 'error';
      break;
    }
    if (c.status === 'warning') overallStatus = 'warning';
  }

  return { status: overallStatus, checkedAt: lastRunAt, checks: checkResults };
}

export function getCheckIds(): string[] {
  return checks.map((c) => c.id);
}

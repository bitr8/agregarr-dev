import PlexAPI from '@server/api/plexapi';
import type { PlexMetadataSafeResult } from '@server/api/plexMetadataClassify';
import { classifyCollectionKey } from '@server/api/plexMetadataClassify';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { getAdminUser } from '@server/lib/collections/core/CollectionUtilities';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { getAppVersion, getCommitTag } from '@server/utils/appVersion';
import { scrubSecrets } from '@server/utils/logRedaction';

type HealthCheckStatus = 'ok' | 'warning' | 'error' | 'skipped';

interface HealthCheck {
  id: string;
  name: string;
  docsUrl?: string;
  run: () => Promise<{ status: HealthCheckStatus; message?: string }>;
}

export interface HealthCheckResult {
  id: string;
  name: string;
  status: HealthCheckStatus;
  message?: string;
  docsUrl?: string;
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

// --- Individual checks ---

const versionStalenessCheck: HealthCheck = {
  id: 'version-staleness',
  name: 'Version',
  docsUrl: 'https://github.com/bitr8/agregarr-dev#version-staleness',
  run: async () => {
    const currentVersion = getAppVersion();
    const commitTag = getCommitTag();

    if (commitTag === 'local') {
      return { status: 'ok', message: 'Running local development build' };
    }

    try {
      if (currentVersion.startsWith('develop-')) {
        const res = await fetch(
          'https://api.github.com/repos/bitr8/agregarr-dev/commits?per_page=21',
          {
            headers: { Accept: 'application/vnd.github.v3+json' },
            signal: AbortSignal.timeout(5000),
          }
        );
        if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
        const commits = (await res.json()) as {
          sha: string;
          commit: { message: string };
        }[];
        const filtered = commits.filter(
          (c) => !c.commit.message.includes('[skip ci]')
        );
        if (!filtered.length) return { status: 'ok' };
        if (filtered[0].sha === commitTag) return { status: 'ok' };

        const idx = filtered.findIndex((c) => c.sha === commitTag);
        if (idx === -1) {
          return {
            status: 'warning',
            message: `Running ${currentVersion} — significantly behind latest release`,
          };
        }
        return {
          status: 'warning',
          message: `Running ${currentVersion} (${idx} commits behind latest)`,
        };
      }

      const res = await fetch(
        'https://api.github.com/repos/bitr8/agregarr-dev/releases?per_page=1',
        {
          headers: { Accept: 'application/vnd.github.v3+json' },
          signal: AbortSignal.timeout(5000),
        }
      );
      if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
      const releases = (await res.json()) as { name: string }[];
      if (releases.length && !releases[0].name.includes(currentVersion)) {
        return {
          status: 'warning',
          message: `Running v${currentVersion}; latest is ${releases[0].name}`,
        };
      }
      return { status: 'ok' };
    } catch (err) {
      return {
        status: 'error',
        message: sanitize(
          `Could not check for updates — ${
            err instanceof Error ? err.message : String(err)
          }`
        ),
      };
    }
  },
};

const connectionPlexCheck: HealthCheck = {
  id: 'connection:plex',
  name: 'Plex Connection',
  docsUrl: 'https://github.com/bitr8/agregarr-dev#connection-plex',
  run: async () => {
    const settings = getSettings();
    if (!settings.plex.ip) return { status: 'skipped' };

    const admin = await getAdminUser();
    if (!admin?.plexToken) {
      return { status: 'error', message: 'No Plex admin user configured' };
    }

    try {
      const plex = new PlexAPI({ plexToken: admin.plexToken });
      await plex.getStatus();
      return { status: 'ok' };
    } catch (err) {
      return {
        status: 'error',
        message: sanitize(
          `Plex unreachable: ${
            err instanceof Error ? err.message : String(err)
          }`
        ),
      };
    }
  },
};

const buildConnectionArrCheck = (
  service: 'sonarr' | 'radarr'
): HealthCheck => ({
  id: `connection:${service}`,
  name: `${service[0].toUpperCase()}${service.slice(1)} Connection`,
  docsUrl: `https://github.com/bitr8/agregarr-dev#connection-${service}`,
  run: async () => {
    const settings = getSettings();
    const instances = settings[service];
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
        failures.push(
          sanitize(
            `${service[0].toUpperCase()}${service.slice(1)} instance '${
              inst.name
            }' unreachable: ${err instanceof Error ? err.message : String(err)}`
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
  docsUrl: 'https://github.com/bitr8/agregarr-dev#connection-tmdb',
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
        status: 'error',
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
  docsUrl: 'https://github.com/bitr8/agregarr-dev#connection-ratings-proxy',
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
        status: 'error',
        message: sanitize(
          `Ratings proxy unreachable: ${
            err instanceof Error ? err.message : String(err)
          }`
        ),
      };
    }
  },
};

const collectionsErrorStateCheck: HealthCheck = {
  id: 'collections-error-state',
  name: 'Collection Sync Errors',
  docsUrl: 'https://github.com/bitr8/agregarr-dev#collections-error-state',
  run: async () => {
    const settings = getSettings();
    const configs = settings.plex.collectionConfigs ?? [];
    const errored = configs.filter((c) => c.lastSyncError);

    if (!errored.length) return { status: 'ok' };

    const names = errored.slice(0, 5).map((c) => c.name || `config ${c.id}`);
    const suffix = errored.length > 5 ? ` and ${errored.length - 5} more` : '';
    return {
      status: 'warning',
      message: sanitize(
        `${errored.length} collection${errored.length === 1 ? '' : 's'} ${
          errored.length === 1 ? 'has' : 'have'
        } sync errors: ${names.join(', ')}${suffix}`
      ),
    };
  },
};

const orphanedCollectionKeysCheck: HealthCheck = {
  id: 'orphaned-collection-keys',
  name: 'Orphaned Collection Keys',
  docsUrl: 'https://github.com/bitr8/agregarr-dev#orphaned-collection-keys',
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

    // Self-gate: probe first key for Plex reachability (P8)
    const firstResult: PlexMetadataSafeResult = await plex.getMetadataSafe(
      entries[0].key
    );
    if (firstResult.status === 'error') {
      return {
        status: 'error',
        message: 'Plex unreachable — orphan status not assessed',
      };
    }

    // Process first key
    const firstState = classifyCollectionKey(firstResult);
    if (firstState === 'absent' || firstState === 'not-a-collection') {
      orphaned.push(entries[0].configName);
    }

    // Process remaining keys sequentially with early-abort
    for (let i = 1; i < entries.length; i++) {
      const result = await plex.getMetadataSafe(entries[i].key);
      if (result.status === 'error') {
        return {
          status: 'error',
          message: 'Plex unreachable — orphan status not assessed',
        };
      }
      const state = classifyCollectionKey(result);
      if (state === 'absent' || state === 'not-a-collection') {
        orphaned.push(entries[i].configName);
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

const timezoneConfigurationCheck: HealthCheck = {
  id: 'timezone-configuration',
  name: 'Timezone',
  docsUrl: 'https://github.com/bitr8/agregarr-dev#timezone-configuration',
  run: async () => {
    const tz = process.env.TZ;
    const settings = getSettings();
    const hasSonarr = settings.sonarr.length > 0;

    if (tz && tz !== 'UTC') return { status: 'ok' };
    if (!hasSonarr) return { status: 'ok' };

    return {
      status: 'warning',
      message:
        'Server timezone is UTC. Air-date day boundaries may differ from Sonarr by one day. Set TZ in your container environment.',
    };
  },
};

// --- Registry ---

const checks: HealthCheck[] = [
  versionStalenessCheck,
  connectionPlexCheck,
  buildConnectionArrCheck('sonarr'),
  buildConnectionArrCheck('radarr'),
  connectionTmdbCheck,
  connectionRatingsProxyCheck,
  collectionsErrorStateCheck,
  orphanedCollectionKeysCheck,
  timezoneConfigurationCheck,
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
          const r: HealthCheckResult = {
            id: check.id,
            name: check.name,
            status: result.status,
            message: result.message,
            docsUrl: check.docsUrl,
            durationMs: Date.now() - start,
            checkedAt: new Date().toISOString(),
          };
          results.set(check.id, r);
        } catch (err) {
          results.set(check.id, {
            id: check.id,
            name: check.name,
            status: 'error',
            message: sanitize(err instanceof Error ? err.message : String(err)),
            docsUrl: check.docsUrl,
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
      docsUrl: check.docsUrl,
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

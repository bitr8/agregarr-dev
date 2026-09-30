import PlexAPI from '@server/api/plexapi';
import type { StatisticsProviderType } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { TautulliStatisticsProvider } from '@server/lib/statistics/tautulliProvider';
import { TracearrStatisticsProvider } from '@server/lib/statistics/tracearrProvider';
import type { StatisticsProvider } from '@server/lib/statistics/types';

export * from '@server/lib/statistics/types';

const DISPLAY_NAMES: Record<StatisticsProviderType, string> = {
  tautulli: 'Tautulli',
  tracearr: 'Tracearr',
};

export function getStatisticsProviderDisplayName(
  type: StatisticsProviderType = getStatisticsProviderType()
): string {
  return DISPLAY_NAMES[type] ?? type;
}

/** The provider the user selected (defaults to Tautulli for older configs) */
export function getStatisticsProviderType(): StatisticsProviderType {
  return getSettings().statistics?.provider ?? 'tautulli';
}

/** Whether the given (default: selected) provider has a host and API key */
export function isStatisticsProviderConfigured(
  type: StatisticsProviderType = getStatisticsProviderType()
): boolean {
  const settings = getSettings();
  const service = type === 'tracearr' ? settings.tracearr : settings.tautulli;
  return !!(service?.hostname && service?.apiKey);
}

/**
 * Plex client for providers that need to read collection membership.
 * Resolved lazily so simply constructing a provider never touches the DB.
 */
async function getPlexClient(): Promise<PlexAPI> {
  const { getAdminUser } = await import(
    '@server/lib/collections/core/CollectionUtilities'
  );
  const admin = await getAdminUser();
  if (!admin?.plexToken) {
    throw new Error('No local admin Plex token found');
  }
  return new PlexAPI({
    plexToken: admin.plexToken,
    plexSettings: getSettings().plex,
  });
}

/**
 * Build the selected statistics provider, or null when it is not configured.
 * A fresh instance is returned each call so settings changes apply immediately.
 */
export function getStatisticsProvider(): StatisticsProvider | null {
  const type = getStatisticsProviderType();
  if (!isStatisticsProviderConfigured(type)) {
    return null;
  }
  return createStatisticsProvider(type);
}

/** Build a specific provider from the saved settings, regardless of selection */
export function createStatisticsProvider(
  type: StatisticsProviderType
): StatisticsProvider {
  const settings = getSettings();
  if (type === 'tracearr') {
    return new TracearrStatisticsProvider(settings.tracearr, getPlexClient);
  }
  return new TautulliStatisticsProvider(settings.tautulli);
}

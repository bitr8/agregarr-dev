export const DEFAULT_PLACEHOLDER_DAYS_AHEAD = 90;
export const DEFAULT_PLACEHOLDER_RELEASED_DAYS = 14;

interface PlaceholderWindowConfig {
  placeholderDaysAhead?: number;
  placeholderReleasedDays?: number;
  comingSoonDays?: number;
  comingSoonReleasedDays?: number;
}

export function resolvePlaceholderDaysAhead(
  config: PlaceholderWindowConfig
): number {
  return (
    config.placeholderDaysAhead ??
    config.comingSoonDays ??
    DEFAULT_PLACEHOLDER_DAYS_AHEAD
  );
}

export function resolvePlaceholderReleasedDays(
  config: PlaceholderWindowConfig
): number {
  return (
    config.placeholderReleasedDays ??
    config.comingSoonReleasedDays ??
    DEFAULT_PLACEHOLDER_RELEASED_DAYS
  );
}

export function placeholdersEnabled(config: {
  type?: string;
  createPlaceholdersForMissing?: boolean;
}): boolean {
  return (
    config.type === 'comingsoon' || config.createPlaceholdersForMissing === true
  );
}

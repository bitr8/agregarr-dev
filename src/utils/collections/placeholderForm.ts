import {
  DEFAULT_PLACEHOLDER_DAYS_AHEAD,
  DEFAULT_PLACEHOLDER_RELEASED_DAYS,
  placeholdersEnabled,
  resolvePlaceholderDaysAhead,
  resolvePlaceholderReleasedDays,
} from '@server/constants/placeholders';

interface StoredPlaceholderConfig {
  type?: string;
  createPlaceholdersForMissing?: boolean;
  placeholderDaysAhead?: number;
  placeholderReleasedDays?: number;
  comingSoonDays?: number;
  comingSoonReleasedDays?: number;
}

export function placeholderInitialValues(config: StoredPlaceholderConfig) {
  return {
    createPlaceholdersForMissing:
      config.type === 'comingsoon' ||
      (config.createPlaceholdersForMissing ?? false),
    placeholderReleasedDays: resolvePlaceholderReleasedDays(config),
    placeholderDaysAhead: resolvePlaceholderDaysAhead(config),
  };
}

function toWindowDays(
  value: number | string | undefined | null,
  fallback: number
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = parseInt(value.toString(), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function placeholderSaveValues(
  values: {
    type?: string;
    createPlaceholdersForMissing?: boolean;
    placeholderReleasedDays?: number | string;
    placeholderDaysAhead?: number | string;
  },
  isEssentials: boolean
) {
  const enabled = !isEssentials && placeholdersEnabled(values);
  return {
    createPlaceholdersForMissing: enabled,
    placeholderReleasedDays: enabled
      ? toWindowDays(
          values.placeholderReleasedDays,
          DEFAULT_PLACEHOLDER_RELEASED_DAYS
        )
      : undefined,
    placeholderDaysAhead: enabled
      ? toWindowDays(
          values.placeholderDaysAhead,
          DEFAULT_PLACEHOLDER_DAYS_AHEAD
        )
      : undefined,
  };
}

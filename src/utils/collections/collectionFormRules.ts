export { supportsTargetUser } from '@server/utils/targetUserSupport';

export const libraryIdsForPresetMediaType = (
  selectedIds: string[],
  libraries: { key: string; type: string }[],
  mediaType: 'movie' | 'tv'
): string[] => {
  const wanted = mediaType === 'movie' ? 'movie' : 'show';
  const matching = libraries.filter((l) => l.type === wanted).map((l) => l.key);
  if (selectedIds.includes('all')) return matching;
  const kept = selectedIds.filter((id) => matching.includes(id));
  return kept.length > 0 ? kept : matching;
};

export interface TemplateFix {
  template: string;
  customMovieTemplate?: string;
  customTVTemplate?: string;
}

export const normaliseSavedTemplate = (
  template: string | undefined,
  presetValues: string[],
  hasMovieLib: boolean,
  hasTVLib: boolean
): TemplateFix | null => {
  if (presetValues.length === 0) return null;
  if (template && presetValues.includes(template)) return null;
  if (template && presetValues.includes('custom')) {
    const neither = !hasMovieLib && !hasTVLib;
    return {
      template: 'custom',
      ...(hasMovieLib || neither ? { customMovieTemplate: template } : {}),
      ...(hasTVLib || neither ? { customTVTemplate: template } : {}),
    };
  }
  return { template: presetValues[0] };
};

export const resolveTemplateFix = (input: {
  template: string | undefined;
  presetValues: string[];
  hasMovieLib: boolean;
  hasTVLib: boolean;
  pendingEditConversion: boolean;
  sourceChanged?: boolean;
}): { fix: TemplateFix | null; settled: boolean } => {
  const { template, presetValues, hasMovieLib, hasTVLib } = input;
  if (presetValues.length === 0) return { fix: null, settled: false };
  if (input.pendingEditConversion && !input.sourceChanged) {
    if (presetValues.includes('fetch-title'))
      return { fix: null, settled: false };
    return {
      fix: normaliseSavedTemplate(
        template,
        presetValues,
        hasMovieLib,
        hasTVLib
      ),
      settled: true,
    };
  }
  if (template && presetValues.includes(template))
    return { fix: null, settled: true };
  return { fix: { template: presetValues[0] }, settled: true };
};

const HUB_SUBTYPES: Record<string, string[]> = {
  'movie.recentlyadded': ['recently_added'],
  'movie.recentlyreleased': ['recently_released'],
  'tv.recentlyadded': [
    'recently_released_episodes',
    'recently_added_episodes',
    'recently_added',
  ],
  'tv.recentlyaired': ['recently_aired_episodes', 'recently_released_episodes'],
};

export const getPlaceholderHubSubtypes = (
  hubIdentifier: string
): string[] | undefined => HUB_SUBTYPES[hubIdentifier];

export const getSuggestedFilteredHubLabel = (
  hubIdentifier: string,
  fallback: string
): string => {
  if (hubIdentifier === 'tv.recentlyadded') return 'Recently Added Episodes';
  if (hubIdentifier === 'tv.recentlyaired')
    return 'Recently Released Episodes (Individual)';
  return fallback;
};

interface TimeRestrictionBase {
  alwaysActive?: boolean;
  inactiveVisibilityConfig?: {
    usersHome: boolean;
    serverOwnerHome: boolean;
    libraryRecommended: boolean;
  };
}

const DEFAULT_INACTIVE_VISIBILITY = {
  usersHome: false,
  serverOwnerHome: false,
  libraryRecommended: true,
};

export const withDefaultInactiveVisibility = <T extends TimeRestrictionBase>(
  tr: T | undefined
): T =>
  (tr
    ? {
        ...tr,
        inactiveVisibilityConfig:
          tr.inactiveVisibilityConfig ?? DEFAULT_INACTIVE_VISIBILITY,
      }
    : {
        alwaysActive: true,
        removeFromPlexWhenInactive: false,
        inactiveVisibilityConfig: DEFAULT_INACTIVE_VISIBILITY,
      }) as T;

export const resolveDisplayedPosterTemplateId = (
  savedId: number | null | undefined,
  isSeparator: boolean,
  templates: { id: number; name: string; isDefault: boolean }[] | undefined
): number | null => {
  if (savedId) return savedId;
  const builtIn = isSeparator
    ? templates?.find((t) => t.name === 'Separator')
    : undefined;
  const fallback =
    templates?.find((t) => t.isDefault) ||
    templates?.find((t) => t.name === 'Default Agregarr Template');
  return (builtIn || fallback)?.id ?? null;
};

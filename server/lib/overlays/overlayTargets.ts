export type OverlayArtworkTarget = 'main' | 'season' | 'episode';

export const ALL_OVERLAY_ARTWORK_TARGETS: OverlayArtworkTarget[] = [
  'main',
  'season',
  'episode',
];

export const OVERLAY_ARTWORK_DIMENSIONS: Record<
  OverlayArtworkTarget,
  { width: number; height: number }
> = {
  main: { width: 1000, height: 1500 },
  season: { width: 1000, height: 1500 },
  episode: { width: 1920, height: 1080 },
};

const TARGET_TAG_PREFIX = 'target:';
const TARGET_TAGS = new Set([
  `${TARGET_TAG_PREFIX}main`,
  `${TARGET_TAG_PREFIX}season`,
  `${TARGET_TAG_PREFIX}episode`,
]);

export function getOverlayTargets(tags?: string[]): OverlayArtworkTarget[] {
  const targets = (tags ?? [])
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => TARGET_TAGS.has(tag))
    .map((tag) => tag.slice(TARGET_TAG_PREFIX.length) as OverlayArtworkTarget);

  // Templates created before artwork targets existed remain main-poster
  // templates. This keeps every existing library configuration unchanged.
  return targets.length > 0 ? Array.from(new Set(targets)) : ['main'];
}

export function targetsArtwork(
  tags: string[] | undefined,
  target: OverlayArtworkTarget
): boolean {
  return getOverlayTargets(tags).includes(target);
}

/**
 * Pick one target for places that can only show a single preview. Main and
 * season artwork take precedence because they share the poster aspect ratio;
 * an episode-only template gets the title-card preview.
 */
export function getPrimaryOverlayTarget(tags?: string[]): OverlayArtworkTarget {
  const targets = getOverlayTargets(tags);
  if (targets.includes('main')) return 'main';
  if (targets.includes('season')) return 'season';
  return 'episode';
}

export function isOverlayCompatibleWithLibrary(
  tags: string[] | undefined,
  libraryType: 'movie' | 'show'
): boolean {
  return libraryType === 'show' || targetsArtwork(tags, 'main');
}

export function getDefaultOverlaySyncTargets(
  libraryType: 'movie' | 'show'
): OverlayArtworkTarget[] {
  return libraryType === 'show' ? [...ALL_OVERLAY_ARTWORK_TARGETS] : ['main'];
}

/**
 * Normalize persisted/API sync targets. Undefined values get product defaults,
 * while an explicit empty array remains empty so a job can be disabled for one
 * library. Movie libraries can never acquire TV-only child targets.
 */
export function normalizeOverlaySyncTargets(
  targets: readonly unknown[] | undefined,
  libraryType: 'movie' | 'show'
): OverlayArtworkTarget[] {
  const requested = targets ?? getDefaultOverlaySyncTargets(libraryType);
  const allowed =
    libraryType === 'show'
      ? new Set<OverlayArtworkTarget>(ALL_OVERLAY_ARTWORK_TARGETS)
      : new Set<OverlayArtworkTarget>(['main']);

  return Array.from(
    new Set(
      requested.filter(
        (target): target is OverlayArtworkTarget =>
          typeof target === 'string' &&
          allowed.has(target as OverlayArtworkTarget)
      )
    )
  );
}

export function setOverlayTargetTags(
  tags: string[] | undefined,
  targets: OverlayArtworkTarget[]
): string[] {
  const ordinaryTags = (tags ?? []).filter(
    (tag) => !TARGET_TAGS.has(tag.trim().toLowerCase())
  );
  const normalizedTargets = targets.length > 0 ? targets : ['main'];
  return [
    ...ordinaryTags,
    ...Array.from(new Set(normalizedTargets)).map(
      (target) => `${TARGET_TAG_PREFIX}${target}`
    ),
  ];
}

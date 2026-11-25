import type { CandidateReason } from '@server/interfaces/api/rotationInterfaces';
import { isMultiCollectionPattern } from '@server/lib/collections/core/CollectionUtilities';
import type {
  CollectionConfig,
  PreExistingCollectionConfig,
} from '@server/lib/settings';
import type {
  MemberKind,
  RotationGroup,
  RotationMember,
  RotationOwnSettings,
  RotationSlot,
  Visibility,
} from './types';
import { ALL_HIDDEN } from './types';

export type MemberConfig = CollectionConfig | PreExistingCollectionConfig;

export interface ManagedFields {
  visibilityConfig: Visibility;
  /** undefined = config has no time restriction, leave untouched */
  inactiveVisibilityConfig?: Visibility;
  sortOrderHome: number;
  randomizeHomeOrder: false;
}

type Writable = {
  visibilityConfig: Visibility;
  sortOrderHome?: number;
  randomizeHomeOrder?: boolean;
  timeRestriction?: { inactiveVisibilityConfig?: Visibility };
};

const copyVis = (v: Visibility): Visibility => ({
  usersHome: v.usersHome,
  serverOwnerHome: v.serverOwnerHome,
  libraryRecommended: v.libraryRecommended,
});

const sameVis = (a: Visibility | undefined, b: Visibility): boolean =>
  !!a &&
  a.usersHome === b.usersHome &&
  a.serverOwnerHome === b.serverOwnerHome &&
  a.libraryRecommended === b.libraryRecommended;

export function captureOwn(
  config: MemberConfig,
  now: Date,
  homeAnchor?: RotationOwnSettings['homeAnchor']
): RotationOwnSettings {
  const inactive = config.timeRestriction?.inactiveVisibilityConfig;
  return {
    visibilityConfig: copyVis(config.visibilityConfig),
    inactiveVisibilityConfig: inactive ? copyVis(inactive) : null,
    sortOrderHome: config.sortOrderHome ?? null,
    randomizeHomeOrder: config.randomizeHomeOrder ?? null,
    ...(homeAnchor ? { homeAnchor: { ...homeAnchor } } : {}),
    capturedAt: now.toISOString(),
  };
}

export function managedFields(
  group: RotationGroup,
  member: RotationMember,
  config: MemberConfig,
  slot: RotationSlot | undefined
): ManagedFields {
  const showing = !!slot && slot.occupant === member.key;
  return {
    visibilityConfig: copyVis(showing ? group.surfaces : ALL_HIDDEN),
    inactiveVisibilityConfig: config.timeRestriction
      ? copyVis(ALL_HIDDEN)
      : undefined,
    sortOrderHome: showing && slot ? slot.sortOrderHome : 0,
    randomizeHomeOrder: false,
  };
}

/** Writes managed fields onto the config in place. Returns true when anything changed. */
export function applyManagedFields(
  config: MemberConfig,
  fields: ManagedFields,
  opts?: { adoptPosition?: boolean }
): boolean {
  const c = config as unknown as Writable;
  let changed = false;

  if (!sameVis(c.visibilityConfig, fields.visibilityConfig)) {
    c.visibilityConfig = copyVis(fields.visibilityConfig);
    changed = true;
  }

  if (fields.inactiveVisibilityConfig && c.timeRestriction) {
    if (
      !sameVis(
        c.timeRestriction.inactiveVisibilityConfig,
        fields.inactiveVisibilityConfig
      )
    ) {
      c.timeRestriction.inactiveVisibilityConfig = copyVis(
        fields.inactiveVisibilityConfig
      );
      changed = true;
    }
  }

  const keepDrag =
    opts?.adoptPosition &&
    fields.sortOrderHome > 0 &&
    (c.sortOrderHome ?? 0) > 0;
  if (!keepDrag && c.sortOrderHome !== fields.sortOrderHome) {
    c.sortOrderHome = fields.sortOrderHome;
    changed = true;
  }

  if (c.randomizeHomeOrder === true) {
    c.randomizeHomeOrder = false;
    changed = true;
  }

  return changed;
}

/** Writes the stashed own values back onto the config in place; null deletes the field. */
export function restoreFields(
  config: MemberConfig,
  own: RotationOwnSettings
): void {
  const c = config as unknown as Writable;
  c.visibilityConfig = copyVis(own.visibilityConfig);

  if (c.timeRestriction) {
    if (own.inactiveVisibilityConfig === null) {
      delete c.timeRestriction.inactiveVisibilityConfig;
    } else {
      c.timeRestriction.inactiveVisibilityConfig = copyVis(
        own.inactiveVisibilityConfig
      );
    }
  }

  if (own.sortOrderHome === null) delete c.sortOrderHome;
  else c.sortOrderHome = own.sortOrderHome;

  if (own.randomizeHomeOrder === null) delete c.randomizeHomeOrder;
  else c.randomizeHomeOrder = own.randomizeHomeOrder;
}

export interface OrderRow {
  visibilityConfig?: Visibility;
  sortOrderHome?: number;
}

export const onHome = (r: OrderRow): boolean =>
  !!r.visibilityConfig &&
  (r.visibilityConfig.usersHome ||
    r.visibilityConfig.serverOwnerHome ||
    r.visibilityConfig.libraryRecommended);

/** Visible rows in Home order (stable for equal values). */
export function homeOrder<T extends OrderRow>(items: T[]): T[] {
  return items
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => onHome(r))
    .sort(
      (a, b) => (a.r.sortOrderHome ?? 0) - (b.r.sortOrderHome ?? 0) || a.i - b.i
    )
    .map(({ r }) => r);
}

export interface RestoreHint {
  anchor?: { after: string | null; ordinal: number };
}

/**
 * Puts restored rows back where they were on Home: directly after the row that
 * was above them, else at their original ordinal. Rows that are not back on
 * Home are left alone. Renumbers the Home order densely when the saved values no
 * longer sort that way; other rows keep their relative order.
 */
export function reinsertRestored<T extends OrderRow>(
  items: T[],
  restored: Map<T, RestoreHint>,
  keyOf: (row: T) => string
): void {
  const back = [...restored.keys()].filter(onHome);
  if (back.length === 0) return;
  const backSet = new Set(back);
  const order = homeOrder(items.filter((r) => !backSet.has(r)));
  const memberIndex = new Map(back.map((r, i) => [r, i]));
  const ordinalOf = (r: T): number =>
    restored.get(r)?.anchor?.ordinal ??
    ((r.sortOrderHome ?? 0) > 0 ? (r.sortOrderHome as number) : Infinity);
  const pending = [...back].sort(
    (a, b) =>
      ordinalOf(a) - ordinalOf(b) ||
      (memberIndex.get(a) as number) - (memberIndex.get(b) as number)
  );
  let lastByOrdinal: T | undefined;
  for (const r of pending) {
    const anchor = restored.get(r)?.anchor;
    let at: number | undefined;
    if (anchor) {
      if (anchor.after === null) at = 0;
      else {
        const i = order.findIndex((o) => keyOf(o) === anchor.after);
        if (i >= 0) at = i + 1;
      }
    }
    if (at === undefined) {
      const o = ordinalOf(r);
      at = Number.isFinite(o)
        ? Math.min(Math.max(o - 1, 0), order.length)
        : order.length;
      if (lastByOrdinal) at = Math.max(at, order.indexOf(lastByOrdinal) + 1);
      lastByOrdinal = r;
    }
    order.splice(at, 0, r);
  }
  const value = (r: T) => r.sortOrderHome ?? 0;
  if (order.every((r, i) => i === 0 || value(order[i - 1]) < value(r))) return;
  order.forEach((r, i) => {
    r.sortOrderHome = i + 1;
  });
}

/** Why this config cannot join `groupId` in `libraryId`, or undefined when it can. */
export function classifyCandidate(
  config: MemberConfig,
  kind: MemberKind,
  libraryId: string,
  groups: RotationGroup[],
  groupId?: string
): { reason: CandidateReason; reasonDetail?: string } | undefined {
  if (kind === 'collection') {
    const c = config as CollectionConfig;
    if (
      isMultiCollectionPattern(c) ||
      (c.collectionRatingKeys?.length ?? 0) > 1
    ) {
      return { reason: 'multi_collection' };
    }
    if (c.targetUserId) {
      return {
        reason: 'per_user',
        reasonDetail: c.targetUserLabel || c.targetUserId,
      };
    }
    if (
      c.type === 'filtered_hub' ||
      (c.type === 'plex' && c.subtype === 'separator')
    ) {
      return { reason: 'row_marker' };
    }
  } else if ((config as PreExistingCollectionConfig).excludeFromOrdering) {
    return { reason: 'exclude_label' };
  }

  if (config.libraryId !== libraryId) {
    return { reason: 'other_library', reasonDetail: config.libraryName };
  }

  const key = `${kind}:${config.id}`;
  const other = groups.find(
    (g) => g.id !== groupId && g.members.some((m) => m.key === key)
  );
  if (other) return { reason: 'other_group', reasonDetail: other.name };

  return undefined;
}

export type Visibility = {
  usersHome: boolean;
  serverOwnerHome: boolean;
  libraryRecommended: boolean;
};

export type RotationInterval =
  | 'every_sync'
  | '12h'
  | 'daily'
  | 'weekly'
  | 'monthly_random';

export type RotationOrder = 'sequential' | 'shuffled';
export type MemberKind = 'collection' | 'preExisting';
/** `${MemberKind}:${configId}` */
export type MemberKey = string;

/** Recovery data. null means the field was absent, so restore deletes it again. */
export interface RotationOwnSettings {
  visibilityConfig: Visibility;
  inactiveVisibilityConfig: Visibility | null;
  sortOrderHome: number | null;
  randomizeHomeOrder: boolean | null;
  capturedAt: string;
}

export interface RotationMember {
  key: MemberKey;
  kind: MemberKind;
  configId: string;
  name: string;
  ratingKey?: string;
  /** Present exactly when the group is enabled and the member is bound. */
  own?: RotationOwnSettings;
  addedAt: string;
  unboundSince?: string;
  rebound?: { at: string; previousRatingKey?: string };
}

export interface RotationSlot {
  id: string;
  occupant: MemberKey | null;
  sortOrderHome: number;
  since?: string;
}

export interface RotationState {
  seq: number;
  appliedSeq: number;
  periodKey: string | null;
  lastRotatedAt?: string;
  slots: RotationSlot[];
  queue: MemberKey[];
  shownThisCycle: MemberKey[];
  cycle: number;
  monthly?: { month: string; day: number };
}

export interface RotationGroup {
  id: string;
  name: string;
  libraryId: string;
  enabled: boolean;
  slotCount: number;
  interval: RotationInterval;
  weekday?: number;
  order: RotationOrder;
  surfaces: Visibility;
  members: RotationMember[];
  state: RotationState;
  createdAt: string;
  updatedAt: string;
}

export type Eligibility =
  | 'ok'
  | 'not_in_plex'
  | 'outside_schedule'
  | 'unbound'
  | 'kind_not_allowed';

export interface LocalParts {
  y: number;
  /** 1-12 */
  m: number;
  d: number;
  /** 0 = Sunday */
  dow: number;
  hour: number;
  daysInMonth: number;
}

export type NextChangeKind =
  | 'every_sync'
  | 'boundary'
  | 'monthly_done'
  | 'disabled';

export type PlanEvent =
  | { type: 'rotated'; outgoing: MemberKey[]; incoming: MemberKey[] }
  | {
      type: 'repaired';
      slotId: string;
      outgoing: MemberKey;
      reason: Eligibility;
    }
  | { type: 'filled'; slotId: string; incoming: MemberKey }
  | { type: 'cycle_complete'; cycle: number }
  | { type: 'monthly_day_drawn'; month: string; day: number }
  | { type: 'sanitised'; detail: string };

export interface PlanInput {
  group: RotationGroup;
  eligibility: Record<MemberKey, Eligibility>;
  now: Date;
  toLocal: (d: Date) => LocalParts;
  /** [0,1) */
  rng: () => number;
  /** Only set when called from a full sync. */
  syncRunId?: string;
  /** "Rotate now". */
  force?: boolean;
}

export interface PlanResult {
  state: RotationState;
  changed: boolean;
  rotated: boolean;
  events: PlanEvent[];
}

export const memberKey = (kind: MemberKind, configId: string): MemberKey =>
  `${kind}:${configId}`;

export const ALL_HIDDEN: Visibility = {
  usersHome: false,
  serverOwnerHome: false,
  libraryRecommended: false,
};

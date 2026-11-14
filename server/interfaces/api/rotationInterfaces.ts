import type {
  Eligibility,
  MemberKey,
  MemberKind,
  NextChangeKind,
  RotationInterval,
  RotationOrder,
  RotationOwnSettings,
  Visibility,
} from '@server/lib/rotation/types';

export type {
  Eligibility,
  MemberKey,
  MemberKind,
  RotationInterval,
  RotationOrder,
  RotationOwnSettings,
  Visibility,
};

export type WarningCode =
  | 'pool_not_larger_than_slots'
  | 'empty_slots'
  | 'sitting_out'
  | 'unbound'
  | 'rebound'
  | 'own_settings_missing'
  | 'sync_slower_than_interval'
  | 'invalid';

export interface MemberSummary {
  key: MemberKey;
  kind: MemberKind;
  configId: string;
  name: string;
  posterUrl: string | null;
  state: 'showing' | 'waiting' | 'sitting_out';
  reason?: Eligibility;
  linked?: boolean;
  /** 1-based place in the queue, waiting members only. */
  queuePosition?: number;
}

export interface RotationWarning {
  code: WarningCode;
  members?: { key: MemberKey; name: string; reason?: Eligibility }[];
}

export interface RotationGroupStatus {
  id: string;
  name: string;
  libraryId: string;
  libraryName: string;
  enabled: boolean;
  slotCount: number;
  interval: RotationInterval;
  weekday?: number;
  order: RotationOrder;
  surfaces: Visibility;
  slots: {
    index: number;
    slotId: string;
    occupant: MemberSummary | null;
    since?: string;
  }[];
  /** Planner dry run of the next batch, at most slotCount. */
  upNext: MemberSummary[];
  /** total = eligible members */
  cycle: { number: number; shown: number; total: number };
  memberCount: number;
  nextChange: {
    kind: NextChangeKind;
    /** ISO boundary */
    notBefore?: string;
    /** first scheduled full sync at or after notBefore */
    expectedSyncAt?: string;
  };
  lastRotatedAt?: string;
  seq: number;
  plex: { applied: boolean; applying: boolean; expectedSyncAt?: string };
  warnings: RotationWarning[];
  /** GET /:id only */
  members?: MemberSummary[];
}

export interface GroupInput {
  name: string;
  libraryId: string;
  enabled: boolean;
  slotCount: number;
  interval: RotationInterval;
  weekday?: number;
  order: RotationOrder;
  surfaces: Visibility;
  members: { kind: MemberKind; configId: string }[];
}

export interface PreviewResult {
  now: MemberSummary[];
  upNext: MemberSummary[];
  /** on a surface today, waiting after save */
  leavingHome: MemberSummary[];
  /** not on a surface today, showing after save */
  joiningHome: MemberSummary[];
  /** removed from the group, own settings come back */
  restored: MemberSummary[];
  /** ceil(eligible / slotCount) */
  turnEvery: { rotations: number };
  warnings: RotationWarning[];
}

export type CandidateReason =
  | 'multi_collection'
  | 'per_user'
  | 'row_marker'
  | 'exclude_label'
  | 'other_library'
  | 'other_group';

export interface Candidate {
  key: MemberKey;
  kind: MemberKind;
  configId: string;
  name: string;
  libraryId: string;
  libraryName: string;
  type: string;
  subtype?: string;
  posterUrl: string | null;
  selectable: boolean;
  reason?: CandidateReason;
  /** user label, library name or group name */
  reasonDetail?: string;
}

export interface Membership {
  groupId: string;
  groupName: string;
  showing: boolean;
  slotIndex?: number;
  slotCount: number;
  surfaces: Visibility;
  own: RotationOwnSettings | null;
}

export type MembershipMap = Record<MemberKey, Membership>;

export interface OwnSettingsPatch {
  visibilityConfig?: Visibility;
  inactiveVisibilityConfig?: Visibility;
  randomizeHomeOrder?: boolean;
}

export interface RotateResult {
  rotated: boolean;
  reason?: 'pool_not_larger_than_slots' | 'disabled';
  group: RotationGroupStatus;
}

export interface SavedPreview {
  steps: { slots: MemberSummary[] }[];
}

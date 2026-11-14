import type { CandidateReason } from '@server/interfaces/api/rotationInterfaces';
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

export type MemberConfig = CollectionConfig | PreExistingCollectionConfig;

export interface ManagedFields {
  visibilityConfig: Visibility;
  /** undefined = config has no time restriction, leave untouched */
  inactiveVisibilityConfig?: Visibility;
  sortOrderHome: number;
  randomizeHomeOrder: false;
}

export function captureOwn(
  _config: MemberConfig,
  _now: Date
): RotationOwnSettings {
  throw new Error('not implemented');
}

export function managedFields(
  _group: RotationGroup,
  _member: RotationMember,
  _config: MemberConfig,
  _slot: RotationSlot | undefined
): ManagedFields {
  throw new Error('not implemented');
}

/** Writes managed fields onto the config in place. Returns true when anything changed. */
export function applyManagedFields(
  _config: MemberConfig,
  _fields: ManagedFields,
  _opts?: { adoptPosition?: boolean }
): boolean {
  throw new Error('not implemented');
}

/** Writes the stashed own values back onto the config in place; null deletes the field. */
export function restoreFields(
  _config: MemberConfig,
  _own: RotationOwnSettings
): void {
  throw new Error('not implemented');
}

/** Why this config cannot join `groupId` in `libraryId`, or undefined when it can. */
export function classifyCandidate(
  _config: MemberConfig,
  _kind: MemberKind,
  _libraryId: string,
  _groups: RotationGroup[],
  _groupId?: string
): { reason: CandidateReason; reasonDetail?: string } | undefined {
  throw new Error('not implemented');
}

import type {
  Candidate,
  GroupInput,
  Membership,
  MembershipMap,
  OwnSettingsPatch,
  PreviewResult,
  RotationGroupStatus,
  SavedPreview,
} from '@server/interfaces/api/rotationInterfaces';
import type { MemberConfig } from './materialise';
import type { MemberKey, MemberKind } from './types';

export class RotationValidationError extends Error {}
export class RotationNotFoundError extends Error {}

export interface PassResult {
  /** group ids whose occupants changed */
  changed: string[];
  rotated: string[];
  saved: boolean;
}

class RotationGroupService {
  public hasGroups(): boolean {
    throw new Error('not implemented');
  }

  public hasEnabledGroups(): boolean {
    throw new Error('not implemented');
  }

  /** Synchronous from first read to save(). No groups: returns before doing or logging anything. */
  public runPass(_opts?: {
    syncRunId?: string;
    now?: Date;
    forceGroupId?: string;
  }): PassResult {
    throw new Error('not implemented');
  }

  /** appliedSeq = seq for one group, or all when omitted. */
  public markApplied(_groupId?: string): void {
    throw new Error('not implemented');
  }

  /** Recompute managed fields from stash + state; saves only on a difference. */
  public reassertManagedFields(): void {
    throw new Error('not implemented');
  }

  public onCollectionDeleted(_configId: string): void {
    throw new Error('not implemented');
  }

  public async listStatus(): Promise<RotationGroupStatus[]> {
    throw new Error('not implemented');
  }

  /** With `members`. Throws RotationNotFoundError. */
  public async getStatus(_id: string): Promise<RotationGroupStatus> {
    throw new Error('not implemented');
  }

  /** Throws RotationValidationError. */
  public async createGroup(_input: GroupInput): Promise<RotationGroupStatus> {
    throw new Error('not implemented');
  }

  public async updateGroup(
    _id: string,
    _input: GroupInput
  ): Promise<RotationGroupStatus> {
    throw new Error('not implemented');
  }

  public deleteGroup(_id: string): void {
    throw new Error('not implemented');
  }

  public async previewDraft(
    _input: GroupInput & { id?: string }
  ): Promise<PreviewResult> {
    throw new Error('not implemented');
  }

  public async previewSaved(
    _id: string,
    _steps: number
  ): Promise<SavedPreview> {
    throw new Error('not implemented');
  }

  /** Forced pass for one group; does not touch Plex. */
  public rotateNow(_id: string): {
    rotated: boolean;
    reason?: 'pool_not_larger_than_slots' | 'disabled';
  } {
    throw new Error('not implemented');
  }

  public moveToFront(_id: string, _key: MemberKey): void {
    throw new Error('not implemented');
  }

  public async listCandidates(_libraryId?: string): Promise<Candidate[]> {
    throw new Error('not implemented');
  }

  public getMembershipMap(): MembershipMap {
    throw new Error('not implemented');
  }

  /** Writes the stash only. Throws RotationNotFoundError when not a member. */
  public patchOwn(
    _kind: MemberKind,
    _configId: string,
    _patch: OwnSettingsPatch
  ): Membership {
    throw new Error('not implemented');
  }

  /** Copy of the config with the member's own values substituted; identity for non-members. */
  public withOwnSettings<T extends MemberConfig>(
    config: T,
    _kind: MemberKind
  ): T {
    return config;
  }

  public isMemberRatingKey(_ratingKey: string): boolean {
    throw new Error('not implemented');
  }
}

export const rotationGroupService = new RotationGroupService();
export default rotationGroupService;

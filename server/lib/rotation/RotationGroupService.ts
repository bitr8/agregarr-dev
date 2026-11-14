import type {
  Candidate,
  GroupInput,
  Membership,
  MembershipMap,
  MemberSummary,
  OwnSettingsPatch,
  PreviewResult,
  RotationGroupStatus,
  RotationWarning,
  SavedPreview,
} from '@server/interfaces/api/rotationInterfaces';
import { TimeRestrictionUtils } from '@server/lib/collections/utils/TimeRestrictionUtils';
import MetadataTrackingService from '@server/lib/metadata/MetadataTrackingService';
import { getPosterUrl } from '@server/lib/posterStorage';
import type { CollectionConfig } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import parser from 'cron-parser';
import { randomUUID } from 'crypto';
import { emptyState, nextBoundary, planRotation, simulate } from './engine';
import type { ManagedFields, MemberConfig } from './materialise';
import {
  applyManagedFields,
  captureOwn,
  classifyCandidate,
  managedFields,
  restoreFields,
} from './materialise';
import { rotationApply } from './rotationApply';
import type {
  Eligibility,
  LocalParts,
  MemberKey,
  MemberKind,
  RotationGroup,
  RotationInterval,
  RotationMember,
  RotationOwnSettings,
  RotationState,
  Visibility,
} from './types';
import { ALL_HIDDEN, memberKey } from './types';

export class RotationValidationError extends Error {}
export class RotationNotFoundError extends Error {}

export interface PassResult {
  /** group ids whose occupants changed */
  changed: string[];
  rotated: string[];
  saved: boolean;
}

const LABEL = 'Rotation';
const INTERVALS: RotationInterval[] = [
  'every_sync',
  '12h',
  'daily',
  'weekly',
  'monthly_random',
];
const PERIOD_MS: Partial<Record<RotationInterval, number>> = {
  '12h': 12 * 3600e3,
  daily: 24 * 3600e3,
  weekly: 7 * 24 * 3600e3,
  monthly_random: 28 * 24 * 3600e3,
};
const REBOUND_WARNING_MS = 14 * 24 * 3600e3;

const REASON_MESSAGES: Record<string, string> = {
  multi_collection: 'creates several collections, so it cannot take one slot',
  per_user: 'is only visible to one user',
  row_marker: 'marks or replaces a Plex row and does not rotate',
  exclude_label: 'has the exclude-from-ordering label',
  other_library: 'is in a different library',
  other_group: 'is already in another rotation',
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const toLocal = (d: Date): LocalParts => ({
  y: d.getFullYear(),
  m: d.getMonth() + 1,
  d: d.getDate(),
  dow: d.getDay(),
  hour: d.getHours(),
  daysInMonth: new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(),
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const isValidGroup = (g: unknown): g is RotationGroup => {
  const x = g as RotationGroup | undefined;
  return (
    !!x &&
    typeof x.id === 'string' &&
    Array.isArray(x.members) &&
    !!x.state &&
    Array.isArray(x.state.slots) &&
    Array.isArray(x.state.queue) &&
    Array.isArray(x.state.shownThisCycle)
  );
};

const isOnSurface = (v?: Visibility): boolean =>
  !!v && (v.usersHome || v.serverOwnerHome || v.libraryRecommended);

interface ConfigWrite {
  config: MemberConfig;
  fields: ManagedFields;
  adoptPosition: boolean;
}

class RotationGroupService {
  private groupList(): RotationGroup[] {
    return (getSettings().plex.rotationGroups ?? []).filter(
      (g) => !!g && typeof g === 'object'
    );
  }

  private validGroups(): RotationGroup[] {
    return this.groupList().filter(isValidGroup);
  }

  public hasGroups(): boolean {
    return this.groupList().length > 0;
  }

  public hasEnabledGroups(): boolean {
    return this.validGroups().some((g) => g.enabled);
  }

  private findConfig(
    kind: MemberKind,
    configId: string
  ): MemberConfig | undefined {
    const plex = getSettings().plex;
    return kind === 'collection'
      ? plex.collectionConfigs?.find((c) => c.id === configId)
      : plex.preExistingCollectionConfigs?.find((c) => c.id === configId);
  }

  private memberConfig(member: RotationMember): MemberConfig | undefined {
    return this.findConfig(member.kind, member.configId);
  }

  private eligibilityOf(
    group: RotationGroup,
    member: RotationMember,
    now: Date
  ): Eligibility {
    const config = this.memberConfig(member);
    if (!config || member.unboundSince) return 'unbound';
    if (
      classifyCandidate(
        config,
        member.kind,
        group.libraryId,
        this.validGroups(),
        group.id
      )
    ) {
      return 'kind_not_allowed';
    }
    if (config.missing || !config.collectionRatingKey) return 'not_in_plex';
    if (
      !TimeRestrictionUtils.evaluateTimeRestriction(config.timeRestriction, now)
        .isActive
    ) {
      return 'outside_schedule';
    }
    return 'ok';
  }

  private eligibilityMap(
    group: RotationGroup,
    now: Date
  ): Record<MemberKey, Eligibility> {
    const map: Record<MemberKey, Eligibility> = {};
    for (const m of group.members)
      map[m.key] = this.eligibilityOf(group, m, now);
    return map;
  }

  private slotOf(group: RotationGroup, key: MemberKey) {
    return group.state.slots.find((s) => s.occupant === key);
  }

  /** Mark vanished members, re-bind recreated pre-existing ones. Mutates the given (cloned) group. */
  private takenKeys(): Set<MemberKey> {
    return new Set(
      this.validGroups().flatMap((g) =>
        g.members.map((m) => memberKey(m.kind, m.configId))
      )
    );
  }

  private rebind(group: RotationGroup, now: Date, taken: Set<MemberKey>): void {
    const plex = getSettings().plex;
    const iso = now.toISOString();
    for (const member of group.members) {
      const config = this.memberConfig(member);
      if (config) {
        if (member.unboundSince) delete member.unboundSince;
        if (member.name !== config.name) member.name = config.name;
        if (
          config.collectionRatingKey &&
          member.ratingKey !== config.collectionRatingKey
        ) {
          member.ratingKey = config.collectionRatingKey;
        }
        continue;
      }
      if (member.kind === 'preExisting') {
        const lower = member.name.toLowerCase();
        const matches = (plex.preExistingCollectionConfigs ?? []).filter(
          (c) =>
            c.libraryId === group.libraryId &&
            c.name.toLowerCase() === lower &&
            !taken.has(memberKey('preExisting', c.id))
        );
        if (matches.length === 1) {
          const found = matches[0];
          const oldKey = member.key;
          const newKey = memberKey('preExisting', found.id);
          const previousRatingKey = member.ratingKey;
          member.configId = found.id;
          member.key = newKey;
          member.name = found.name;
          member.ratingKey = found.collectionRatingKey;
          member.rebound = { at: iso, previousRatingKey };
          delete member.unboundSince;
          member.own = captureOwn(found, now);
          const s = group.state;
          s.queue = s.queue.map((k) => (k === oldKey ? newKey : k));
          s.shownThisCycle = s.shownThisCycle.map((k) =>
            k === oldKey ? newKey : k
          );
          for (const slot of s.slots) {
            if (slot.occupant === oldKey) slot.occupant = newKey;
          }
          taken.add(newKey);
          continue;
        }
      }
      if (!member.unboundSince) member.unboundSince = iso;
    }
  }

  private adoptPositions(group: RotationGroup): void {
    for (const slot of group.state.slots) {
      if (!slot.occupant) continue;
      const member = group.members.find((m) => m.key === slot.occupant);
      const config = member && this.memberConfig(member);
      const pos = config?.sortOrderHome;
      if (pos && pos > 0) slot.sortOrderHome = pos;
    }
  }

  /** Managed-field writes for every bound member of an enabled group, changed ones only. */
  private planConfigWrites(
    group: RotationGroup,
    adoptPosition: boolean
  ): ConfigWrite[] {
    const writes: ConfigWrite[] = [];
    for (const member of group.members) {
      const config = this.memberConfig(member);
      if (!config || member.unboundSince) continue;
      const fields = managedFields(
        group,
        member,
        config,
        this.slotOf(group, member.key)
      );
      const probe = clone(config);
      if (applyManagedFields(probe, fields, { adoptPosition })) {
        writes.push({ config, fields, adoptPosition });
      }
    }
    return writes;
  }

  private commitWrites(writes: ConfigWrite[]): void {
    for (const w of writes) {
      applyManagedFields(w.config, w.fields, {
        adoptPosition: w.adoptPosition,
      });
    }
  }

  private replaceGroup(next: RotationGroup): void {
    const groups = getSettings().plex.rotationGroups as RotationGroup[];
    const idx = groups.findIndex((g) => g.id === next.id);
    if (idx >= 0) groups[idx] = next;
  }

  private logChange(
    group: RotationGroup,
    before: RotationGroup,
    after: RotationGroup,
    events: ReturnType<typeof planRotation>['events']
  ): void {
    const outgoing: MemberKey[] = [];
    const incoming: MemberKey[] = [];
    for (const e of events) {
      if (e.type === 'rotated') {
        outgoing.push(...e.outgoing);
        incoming.push(...e.incoming);
      } else if (e.type === 'repaired') outgoing.push(e.outgoing);
      else if (e.type === 'filled') incoming.push(e.incoming);
    }
    if (outgoing.length === 0 && incoming.length === 0) return;
    const names = new Map(
      [...before.members, ...after.members].map((m) => [m.key, m.name])
    );
    const label = (keys: MemberKey[]) =>
      keys.map((k) => names.get(k) ?? k).join(', ') || 'none';
    logger.info(
      `Rotation "${group.name}": out [${label(outgoing)}], in [${label(
        incoming
      )}], period ${after.state.periodKey ?? 'n/a'}`,
      { label: LABEL }
    );
  }

  /** Synchronous from first read to save(). No groups: returns before doing or logging anything. */
  public runPass(opts?: {
    syncRunId?: string;
    now?: Date;
    forceGroupId?: string;
  }): PassResult {
    const result: PassResult = { changed: [], rotated: [], saved: false };
    if (!this.hasEnabledGroups()) return result;

    const now = opts?.now ?? new Date();
    const settings = getSettings();
    const next: RotationGroup[] = [];
    const writes: ConfigWrite[] = [];
    const logs: (() => void)[] = [];
    const taken = this.takenKeys();
    let dirty = false;

    for (const group of this.validGroups()) {
      if (!group.enabled) continue;
      if (opts?.forceGroupId && group.id !== opts.forceGroupId) continue;
      const draft = clone(group);
      this.rebind(draft, now, taken);
      this.adoptPositions(draft);
      const plan = planRotation({
        group: draft,
        eligibility: this.eligibilityMap(draft, now),
        now,
        toLocal,
        rng: Math.random,
        syncRunId: opts?.syncRunId,
        force: opts?.forceGroupId === group.id,
      });
      draft.state = plan.state;
      const groupWrites = this.planConfigWrites(draft, false);
      const groupDirty =
        JSON.stringify(draft) !== JSON.stringify(group) ||
        groupWrites.length > 0;
      if (!groupDirty) continue;
      dirty = true;
      next.push(draft);
      writes.push(...groupWrites);
      if (plan.rotated) result.rotated.push(group.id);
      if (draft.state.seq !== group.state.seq) result.changed.push(group.id);
      logs.push(() => this.logChange(group, group, draft, plan.events));
    }

    if (!dirty) return result;

    for (const g of next) this.replaceGroup(g);
    this.commitWrites(writes);
    settings.save();
    result.saved = true;
    logs.forEach((l) => l());
    return result;
  }

  /** Orders the libraries of enabled groups, then re-adopts slot positions. */
  public async settlePositions(extraLibraries: string[] = []): Promise<void> {
    const libraries = [
      ...new Set([
        ...this.validGroups()
          .filter((g) => g.enabled)
          .map((g) => g.libraryId),
        ...extraLibraries,
      ]),
    ];
    if (libraries.length === 0) return;
    const { autoReorderLibrary } = await import('@server/routes/reorder');
    for (const lib of libraries) await autoReorderLibrary(lib, 'home');
    let changed = false;
    for (const g of this.validGroups()) {
      if (!g.enabled) continue;
      const before = JSON.stringify(g.state.slots);
      this.adoptPositions(g);
      if (JSON.stringify(g.state.slots) !== before) changed = true;
    }
    if (changed) getSettings().save();
  }

  /** seq of every valid group right now; pass to markApplied once Plex has been brought up to it. */
  public captureSeqs(): Record<string, number> {
    return Object.fromEntries(
      this.validGroups().map((g) => [g.id, g.state.seq])
    );
  }

  /** appliedSeq = the captured seq, never the live one, so a change made mid-apply stays unapplied. */
  public markApplied(captured: Record<string, number>): void {
    if (!this.hasGroups()) return;
    let changed = false;
    for (const g of this.validGroups()) {
      const seq = captured[g.id];
      if (seq !== undefined && seq > g.state.appliedSeq) {
        g.state.appliedSeq = seq;
        changed = true;
      }
    }
    if (changed) getSettings().save();
  }

  /** Recompute managed fields from stash + state; saves only on a difference. */
  public reassertManagedFields(): void {
    if (!this.hasEnabledGroups()) return;
    const writes: ConfigWrite[] = [];
    const adopted: { group: RotationGroup; slotId: string; pos: number }[] = [];
    for (const group of this.validGroups()) {
      if (!group.enabled) continue;
      for (const slot of group.state.slots) {
        if (!slot.occupant) continue;
        const member = group.members.find((m) => m.key === slot.occupant);
        const pos = member && this.memberConfig(member)?.sortOrderHome;
        if (pos && pos > 0 && pos !== slot.sortOrderHome) {
          adopted.push({ group, slotId: slot.id, pos });
        }
      }
      writes.push(...this.planConfigWrites(group, true));
    }
    if (writes.length === 0 && adopted.length === 0) return;
    for (const a of adopted) {
      const slot = a.group.state.slots.find((s) => s.id === a.slotId);
      if (slot) slot.sortOrderHome = a.pos;
    }
    this.commitWrites(writes);
    getSettings().save();
  }

  private restoreMember(group: RotationGroup, member: RotationMember): void {
    const config = this.memberConfig(member);
    if (!config) return;
    if (member.own) {
      restoreFields(config, member.own);
      return;
    }
    if (member.unboundSince) return;
    logger.warn(
      `Rotation "${group.name}": own settings for "${member.name}" are missing, leaving it hidden`,
      { label: LABEL }
    );
    Object.assign(config as Mutable<MemberConfig>, {
      visibilityConfig: { ...ALL_HIDDEN },
      sortOrderHome: 0,
    });
  }

  private afterChange(libraryId?: string): void {
    void (async () => {
      try {
        await this.settlePositions(libraryId ? [libraryId] : []);
        rotationApply.kick();
      } catch (error) {
        logger.error('Rotation follow-up failed', {
          label: LABEL,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }

  public onCollectionDeleted(configId: string): void {
    if (!this.hasGroups()) return;
    const key = memberKey('collection', configId);
    const now = new Date();
    const libraries = new Set<string>();
    for (const group of this.validGroups()) {
      if (!group.members.some((m) => m.key === key)) continue;
      libraries.add(group.libraryId);
      const draft = clone(group);
      draft.members = draft.members.filter((m) => m.key !== key);
      const s = draft.state;
      s.queue = s.queue.filter((k) => k !== key);
      s.shownThisCycle = s.shownThisCycle.filter((k) => k !== key);
      for (const slot of s.slots)
        if (slot.occupant === key) slot.occupant = null;
      if (draft.enabled) {
        draft.state = planRotation({
          group: draft,
          eligibility: this.eligibilityMap(draft, now),
          now,
          toLocal,
          rng: Math.random,
        }).state;
        this.commitWrites(this.planConfigWrites(draft, false));
      }
      this.replaceGroup(draft);
    }
    if (libraries.size > 0) {
      getSettings().save();
      for (const lib of libraries) this.afterChange(lib);
    }
  }

  // ---------------------------------------------------------------- validation

  private validateInput(
    input: GroupInput,
    existing: RotationGroup | undefined
  ): { configs: Map<MemberKey, MemberConfig> } {
    const settings = getSettings();
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length < 1 || name.length > 60) {
      throw new RotationValidationError(
        'Name must be between 1 and 60 characters.'
      );
    }
    const lower = name.toLowerCase();
    if (
      this.groupList().some(
        (g) => g.id !== existing?.id && g.name?.toLowerCase() === lower
      )
    ) {
      throw new RotationValidationError(
        `A rotation called "${name}" already exists.`
      );
    }
    if (!settings.plex.libraries.some((l) => l.key === input.libraryId)) {
      throw new RotationValidationError('That library does not exist.');
    }
    if (existing && existing.libraryId !== input.libraryId) {
      throw new RotationValidationError(
        'A rotation works inside one library, so the library cannot be changed.'
      );
    }
    if (
      !Number.isInteger(input.slotCount) ||
      input.slotCount < 1 ||
      input.slotCount > 20
    ) {
      throw new RotationValidationError(
        'Slots must be a whole number from 1 to 20.'
      );
    }
    if (!INTERVALS.includes(input.interval)) {
      throw new RotationValidationError('Pick how often the rotation changes.');
    }
    if (input.interval === 'weekly') {
      if (
        !Number.isInteger(input.weekday) ||
        (input.weekday as number) < 0 ||
        (input.weekday as number) > 6
      ) {
        throw new RotationValidationError(
          'Pick a weekday (0 for Sunday to 6 for Saturday).'
        );
      }
    }
    if (input.order !== 'sequential' && input.order !== 'shuffled') {
      throw new RotationValidationError('Pick an order.');
    }
    const s = input.surfaces;
    if (!s || !(s.usersHome || s.serverOwnerHome || s.libraryRecommended)) {
      throw new RotationValidationError('Pick at least one place to show.');
    }
    if (!Array.isArray(input.members) || input.members.length > 500) {
      throw new RotationValidationError(
        'A rotation can hold up to 500 members.'
      );
    }
    const configs = new Map<MemberKey, MemberConfig>();
    for (const m of input.members) {
      const key = memberKey(m.kind, m.configId);
      if (configs.has(key)) {
        throw new RotationValidationError(
          'The same collection is listed twice.'
        );
      }
      const config = this.findConfig(m.kind, m.configId);
      if (!config) {
        throw new RotationValidationError(
          'One of the collections no longer exists.'
        );
      }
      const problem = classifyCandidate(
        config,
        m.kind,
        input.libraryId,
        this.validGroups(),
        existing?.id
      );
      if (problem) {
        throw new RotationValidationError(
          `"${config.name}" cannot join: it ${
            REASON_MESSAGES[problem.reason] ?? 'cannot rotate'
          }.`
        );
      }
      configs.set(key, config);
    }
    return { configs };
  }

  // ---------------------------------------------------------------- build

  private libraryNextPosition(libraryId: string): number {
    const plex = getSettings().plex;
    const all = [
      ...(plex.collectionConfigs ?? []),
      ...(plex.hubConfigs ?? []),
      ...(plex.preExistingCollectionConfigs ?? []),
    ].filter((c) => String(c.libraryId) === libraryId);
    return all.reduce((max, c) => Math.max(max, c.sortOrderHome ?? 0), 0) + 1;
  }

  /** Builds the group as it would be after saving. Reads configs, writes nothing. */
  private buildDraft(
    input: GroupInput,
    existing: RotationGroup | undefined,
    configs: Map<MemberKey, MemberConfig>,
    now: Date
  ): { group: RotationGroup; restore: RotationMember[] } {
    const iso = now.toISOString();
    const prior = existing ? clone(existing) : undefined;
    const wasEnabled = !!prior?.enabled;
    const members: RotationMember[] = input.members.map((m) => {
      const key = memberKey(m.kind, m.configId);
      const config = configs.get(key) as MemberConfig;
      const kept = prior?.members.find((p) => p.key === key);
      const member: RotationMember = kept ?? {
        key,
        kind: m.kind,
        configId: m.configId,
        name: config.name,
        addedAt: iso,
      };
      member.name = config.name;
      delete member.unboundSince;
      if (config.collectionRatingKey)
        member.ratingKey = config.collectionRatingKey;
      return member;
    });

    const restore: RotationMember[] = [];
    if (prior && wasEnabled) {
      const keep = new Set(members.map((m) => m.key));
      for (const old of prior.members) {
        if (!keep.has(old.key) || !input.enabled) restore.push(clone(old));
      }
    }

    for (const member of members) {
      if (!input.enabled) {
        delete member.own;
      } else if (!member.own && !member.unboundSince) {
        const wasBoundAndEnabled =
          wasEnabled && prior?.members.some((p) => p.key === member.key);
        if (!wasBoundAndEnabled) {
          member.own = captureOwn(configs.get(member.key) as MemberConfig, now);
        }
      }
    }

    const group: RotationGroup = {
      id: prior?.id ?? randomUUID(),
      name: input.name.trim(),
      libraryId: input.libraryId,
      enabled: input.enabled,
      slotCount: input.slotCount,
      interval: input.interval,
      ...(input.interval === 'weekly' ? { weekday: input.weekday } : {}),
      order: input.order,
      surfaces: { ...input.surfaces },
      members,
      state: prior?.state ?? emptyState(),
      createdAt: prior?.createdAt ?? iso,
      updatedAt: iso,
    };

    const state = group.state;
    if (!prior) {
      const start = this.libraryNextPosition(group.libraryId);
      state.slots = Array.from({ length: group.slotCount }, (_, i) => ({
        id: `s${i + 1}`,
        occupant: null,
        sortOrderHome: start + i,
      }));
    }
    const keys = new Set(members.map((m) => m.key));
    state.queue = state.queue.filter((k) => keys.has(k));
    state.shownThisCycle = state.shownThisCycle.filter((k) => keys.has(k));
    for (const slot of state.slots) {
      if (slot.occupant && !keys.has(slot.occupant)) slot.occupant = null;
    }

    if (!input.enabled) {
      if (state.slots.some((s) => s.occupant)) state.seq += 1;
      for (const slot of state.slots) {
        slot.occupant = null;
        delete slot.since;
      }
      return { group, restore };
    }

    if (wasEnabled) this.adoptPositions(group);
    group.state = planRotation({
      group,
      eligibility: this.eligibilityMap(group, now),
      now,
      toLocal,
      rng: Math.random,
    }).state;
    return { group, restore };
  }

  // ---------------------------------------------------------------- CRUD

  public async createGroup(input: GroupInput): Promise<RotationGroupStatus> {
    const { configs } = this.validateInput(input, undefined);
    const now = new Date();
    const { group } = this.buildDraft(input, undefined, configs, now);
    const settings = getSettings();
    const writes = group.enabled ? this.planConfigWrites(group, false) : [];
    settings.plex.rotationGroups = [
      ...(settings.plex.rotationGroups ?? []),
      group,
    ];
    this.commitWrites(writes);
    settings.save();
    this.afterChange(group.libraryId);
    return this.getStatus(group.id);
  }

  public async updateGroup(
    id: string,
    input: GroupInput
  ): Promise<RotationGroupStatus> {
    const existing = this.groupList().find((g) => g.id === id);
    if (!existing || !isValidGroup(existing)) {
      throw new RotationNotFoundError('Rotation not found.');
    }
    const { configs } = this.validateInput(input, existing);
    const now = new Date();
    const { group, restore } = this.buildDraft(input, existing, configs, now);
    const settings = getSettings();
    for (const member of restore) this.restoreMember(existing, member);
    const writes = group.enabled ? this.planConfigWrites(group, false) : [];
    this.replaceGroup(group);
    this.commitWrites(writes);
    settings.save();
    this.afterChange(group.libraryId);
    return this.getStatus(id);
  }

  public deleteGroup(id: string): void {
    const groups = getSettings().plex.rotationGroups ?? [];
    const group = groups.find((g) => g?.id === id);
    if (!group) throw new RotationNotFoundError('Rotation not found.');
    if (group.enabled && Array.isArray(group.members)) {
      for (const member of group.members) {
        if (typeof member?.configId !== 'string') continue;
        if (!member.own && !isValidGroup(group)) continue;
        if (member.kind !== 'collection' && member.kind !== 'preExisting') {
          continue;
        }
        this.restoreMember(group, member);
      }
    }
    const settings = getSettings();
    const rest = groups.filter((g) => g !== group);
    if (rest.length === 0) delete settings.plex.rotationGroups;
    else settings.plex.rotationGroups = rest;
    settings.save();
    this.afterChange(
      typeof group.libraryId === 'string' ? group.libraryId : undefined
    );
  }

  /** Forced pass for one group; does not touch Plex. */
  public rotateNow(id: string): {
    rotated: boolean;
    reason?: 'pool_not_larger_than_slots' | 'disabled';
  } {
    const group = this.groupList().find((g) => g.id === id);
    if (!group) throw new RotationNotFoundError('Rotation not found.');
    if (!group.enabled) return { rotated: false, reason: 'disabled' };
    const pass = this.runPass({ forceGroupId: id });
    if (pass.saved) this.afterChange(group.libraryId);
    if (!pass.rotated.includes(id)) {
      return { rotated: false, reason: 'pool_not_larger_than_slots' };
    }
    return { rotated: true };
  }

  public moveToFront(id: string, key: MemberKey): void {
    const group = this.groupList().find((g) => g.id === id);
    if (!group || !isValidGroup(group)) {
      throw new RotationNotFoundError('Rotation not found.');
    }
    if (!group.enabled) {
      throw new RotationValidationError('This rotation is turned off.');
    }
    if (!group.members.some((m) => m.key === key)) {
      throw new RotationValidationError(
        'That collection is not in this rotation.'
      );
    }
    if (group.state.slots.some((s) => s.occupant === key)) {
      throw new RotationValidationError('That collection is already showing.');
    }
    group.state.queue = [key, ...group.state.queue.filter((k) => k !== key)];
    getSettings().save();
  }

  // ---------------------------------------------------------------- preview

  public async previewDraft(
    input: GroupInput & { id?: string }
  ): Promise<PreviewResult> {
    const existing = input.id
      ? this.groupList().find((g) => g.id === input.id)
      : undefined;
    if (input.id && (!existing || !isValidGroup(existing))) {
      throw new RotationNotFoundError('Rotation not found.');
    }
    const { configs } = this.validateInput(input, existing);
    const now = new Date();
    const { group, restore } = this.buildDraft(input, existing, configs, now);
    const ctx = await this.statusContext(group.state.seq);
    const eligibility = this.eligibilityMap(group, now);
    const showing = new Set(
      group.state.slots.map((s) => s.occupant).filter(Boolean) as MemberKey[]
    );
    const summarise = (m: RotationMember) =>
      this.summary(group, m, eligibility, ctx);
    const onSurfaceToday = (m: RotationMember) =>
      isOnSurface(configs.get(m.key)?.visibilityConfig);
    const kept = group.members;
    const upNext = this.upNextOf(group, eligibility, now).map(summarise);
    const ok = kept.filter((m) => eligibility[m.key] === 'ok').length;
    const restoredSummaries = await Promise.all(
      restore.map(
        async (m): Promise<MemberSummary> => ({
          key: m.key,
          kind: m.kind,
          configId: m.configId,
          name: m.name,
          posterUrl: await this.posterFor(m.ratingKey, group.state.seq, ctx),
          state: 'waiting',
        })
      )
    );
    return {
      now: group.state.slots
        .map((s) => kept.find((m) => m.key === s.occupant))
        .filter((m): m is RotationMember => !!m)
        .map(summarise),
      upNext,
      leavingHome: kept
        .filter((m) => !showing.has(m.key) && onSurfaceToday(m))
        .map(summarise),
      joiningHome: kept
        .filter((m) => showing.has(m.key) && !onSurfaceToday(m))
        .map(summarise),
      restored: group.enabled
        ? restoredSummaries.filter((r) => !kept.some((m) => m.key === r.key))
        : restoredSummaries,
      turnEvery: { rotations: Math.ceil(ok / Math.max(1, group.slotCount)) },
      warnings: this.warningsOf(group, eligibility, now),
    };
  }

  public async previewSaved(id: string, steps: number): Promise<SavedPreview> {
    const group = this.groupList().find((g) => g.id === id);
    if (!group || !isValidGroup(group)) {
      throw new RotationNotFoundError('Rotation not found.');
    }
    const now = new Date();
    const count = Math.min(5, Math.max(1, Math.floor(steps) || 1));
    const eligibility = this.eligibilityMap(group, now);
    const ctx = await this.statusContext(group.state.seq);
    const states = simulate(
      { group, eligibility, now, toLocal, rng: () => 0.5 },
      count
    );
    return {
      steps: states.map((state) => ({
        slots: state.slots
          .map((s) => group.members.find((m) => m.key === s.occupant))
          .filter((m): m is RotationMember => !!m)
          .map((m) => this.summary(group, m, eligibility, ctx, state)),
      })),
    };
  }

  // ---------------------------------------------------------------- status

  private async statusContext(seq: number) {
    return { seq, posters: new Map<string, string | null>() };
  }

  private async posterFor(
    ratingKey: string | undefined,
    seq: number,
    ctx: { posters: Map<string, string | null> }
  ): Promise<string | null> {
    if (!ratingKey) return null;
    if (ctx.posters.has(ratingKey)) return ctx.posters.get(ratingKey) ?? null;
    let url:
      | string
      | null = `/api/v1/rotation-groups/poster/${ratingKey}?v=${seq}`;
    try {
      const file = await MetadataTrackingService.getPosterLocalPath(ratingKey);
      if (file) url = getPosterUrl(file);
    } catch {
      // fall through to the proxy URL
    }
    ctx.posters.set(ratingKey, url);
    return url;
  }

  private summary(
    group: RotationGroup,
    member: RotationMember,
    eligibility: Record<MemberKey, Eligibility>,
    ctx: { seq: number; posters: Map<string, string | null> },
    state: RotationState = group.state
  ): MemberSummary {
    const config = this.memberConfig(member);
    const showing = state.slots.some((s) => s.occupant === member.key);
    const reason = eligibility[member.key];
    const out: MemberSummary = {
      key: member.key,
      kind: member.kind,
      configId: member.configId,
      name: member.name,
      posterUrl: ctx.posters.get(member.ratingKey ?? '') ?? null,
      state: showing ? 'showing' : reason === 'ok' ? 'waiting' : 'sitting_out',
    };
    if (reason !== 'ok') out.reason = reason;
    if (config?.isLinked) out.linked = true;
    if (out.state === 'waiting') {
      const idx = state.queue.indexOf(member.key);
      if (idx >= 0) out.queuePosition = idx + 1;
    }
    return out;
  }

  private async withPosters(
    group: RotationGroup,
    ctx: { seq: number; posters: Map<string, string | null> }
  ): Promise<void> {
    await Promise.all(
      group.members.map((m) => this.posterFor(m.ratingKey, ctx.seq, ctx))
    );
  }

  private upNextOf(
    group: RotationGroup,
    eligibility: Record<MemberKey, Eligibility>,
    now: Date
  ): RotationMember[] {
    if (!group.enabled) return [];
    const [after] = simulate(
      { group, eligibility, now, toLocal, rng: () => 0.5 },
      1
    );
    if (!after) return [];
    const current = new Set(group.state.slots.map((s) => s.occupant));
    return after.slots
      .map((s) => s.occupant)
      .filter((k): k is MemberKey => !!k && !current.has(k))
      .map((k) => group.members.find((m) => m.key === k))
      .filter((m): m is RotationMember => !!m);
  }

  private cronNext(from: Date, count = 1): Date[] {
    try {
      const expr = getSettings().jobs['plex-collections-sync']?.schedule;
      if (!expr) return [];
      const it = parser.parse(expr, { currentDate: from });
      return Array.from({ length: count }, () => it.next().toDate());
    } catch {
      return [];
    }
  }

  private warningsOf(
    group: RotationGroup,
    eligibility: Record<MemberKey, Eligibility>,
    now: Date
  ): RotationWarning[] {
    const warnings: RotationWarning[] = [];
    if (!group.enabled) return warnings;
    const entry = (m: RotationMember) => ({
      key: m.key,
      name: m.name,
      reason: eligibility[m.key],
    });
    const ok = group.members.filter((m) => eligibility[m.key] === 'ok').length;
    if (ok <= group.slotCount)
      warnings.push({ code: 'pool_not_larger_than_slots' });
    if (group.state.slots.some((s) => !s.occupant))
      warnings.push({ code: 'empty_slots' });
    const sitting = group.members.filter(
      (m) => eligibility[m.key] !== 'ok' && eligibility[m.key] !== 'unbound'
    );
    if (sitting.length)
      warnings.push({ code: 'sitting_out', members: sitting.map(entry) });
    const unbound = group.members.filter(
      (m) => eligibility[m.key] === 'unbound'
    );
    if (unbound.length)
      warnings.push({ code: 'unbound', members: unbound.map(entry) });
    const rebound = group.members.filter(
      (m) =>
        m.rebound &&
        now.getTime() - Date.parse(m.rebound.at) < REBOUND_WARNING_MS
    );
    if (rebound.length)
      warnings.push({ code: 'rebound', members: rebound.map(entry) });
    const noOwn = group.members.filter(
      (m) => !m.own && !m.unboundSince && this.memberConfig(m)
    );
    if (noOwn.length) {
      warnings.push({
        code: 'own_settings_missing',
        members: noOwn.map(entry),
      });
    }
    const period = PERIOD_MS[group.interval];
    if (period) {
      const [a, b] = this.cronNext(now, 2);
      if (a && b && b.getTime() - a.getTime() > period) {
        warnings.push({ code: 'sync_slower_than_interval' });
      }
    }
    return warnings;
  }

  private async statusOf(
    group: RotationGroup,
    withMembers: boolean
  ): Promise<RotationGroupStatus> {
    const settings = getSettings();
    const now = new Date();
    const libraryName =
      settings.plex.libraries.find((l) => l.key === group.libraryId)?.name ??
      group.libraryId;
    if (!isValidGroup(group)) {
      return {
        id: String((group as RotationGroup)?.id ?? ''),
        name: String((group as RotationGroup)?.name ?? ''),
        libraryId: (group as RotationGroup | undefined)?.libraryId ?? '',
        libraryName,
        enabled: false,
        slotCount: 0,
        interval: 'daily',
        order: 'sequential',
        surfaces: { ...ALL_HIDDEN },
        slots: [],
        upNext: [],
        cycle: { number: 0, shown: 0, total: 0 },
        memberCount: 0,
        nextChange: { kind: 'disabled' },
        seq: 0,
        plex: { applied: true, applying: false },
        warnings: [{ code: 'invalid' }],
      };
    }
    const ctx = await this.statusContext(group.state.seq);
    await this.withPosters(group, ctx);
    const eligibility = this.eligibilityMap(group, now);
    const sum = (m: RotationMember) => this.summary(group, m, eligibility, ctx);
    const byKey = new Map(group.members.map((m) => [m.key, m]));
    const okKeys = group.members
      .filter((m) => eligibility[m.key] === 'ok')
      .map((m) => m.key);
    const shown = group.state.shownThisCycle.filter((k) =>
      okKeys.includes(k)
    ).length;

    let nextChange: RotationGroupStatus['nextChange'] = { kind: 'disabled' };
    if (group.enabled) {
      const b = nextBoundary(
        group.interval,
        group.weekday,
        now,
        toLocal,
        group.state
      );
      nextChange = { kind: b.kind };
      if (b.notBefore) nextChange.notBefore = b.notBefore.toISOString();
      const from = b.notBefore ?? now;
      const sync = this.cronNext(from)[0];
      if (sync && b.kind !== 'monthly_done' && b.kind !== 'disabled') {
        nextChange.expectedSyncAt = sync.toISOString();
      }
    }

    const applied = group.state.appliedSeq >= group.state.seq;
    const plexSync = !applied ? this.cronNext(now)[0] : undefined;
    const status: RotationGroupStatus = {
      id: group.id,
      name: group.name,
      libraryId: group.libraryId,
      libraryName,
      enabled: group.enabled,
      slotCount: group.slotCount,
      interval: group.interval,
      ...(group.weekday !== undefined ? { weekday: group.weekday } : {}),
      order: group.order,
      surfaces: group.surfaces,
      slots: group.state.slots.map((s, index) => {
        const m = s.occupant ? byKey.get(s.occupant) : undefined;
        return {
          index,
          slotId: s.id,
          occupant: m ? sum(m) : null,
          ...(s.since ? { since: s.since } : {}),
        };
      }),
      upNext: this.upNextOf(group, eligibility, now).map(sum),
      cycle: { number: group.state.cycle, shown, total: okKeys.length },
      memberCount: group.members.length,
      nextChange,
      ...(group.state.lastRotatedAt
        ? { lastRotatedAt: group.state.lastRotatedAt }
        : {}),
      seq: group.state.seq,
      plex: {
        applied,
        applying: rotationApply.status.running,
        ...(plexSync ? { expectedSyncAt: plexSync.toISOString() } : {}),
      },
      warnings: this.warningsOf(group, eligibility, now),
    };
    if (withMembers) status.members = group.members.map(sum);
    return status;
  }

  public async listStatus(): Promise<RotationGroupStatus[]> {
    return Promise.all(this.groupList().map((g) => this.statusOf(g, false)));
  }

  /** With `members`. Throws RotationNotFoundError. */
  public async getStatus(id: string): Promise<RotationGroupStatus> {
    const group = this.groupList().find((g) => g.id === id);
    if (!group) throw new RotationNotFoundError('Rotation not found.');
    return this.statusOf(group, true);
  }

  // ---------------------------------------------------------------- candidates and membership

  public async listCandidates(
    libraryId?: string,
    groupId?: string
  ): Promise<Candidate[]> {
    const plex = getSettings().plex;
    const groups = this.validGroups();
    const ctx = await this.statusContext(0);
    const rows: {
      kind: MemberKind;
      config: MemberConfig;
    }[] = [
      ...(plex.collectionConfigs ?? []).map((config) => ({
        kind: 'collection' as const,
        config,
      })),
      ...(plex.preExistingCollectionConfigs ?? []).map((config) => ({
        kind: 'preExisting' as const,
        config,
      })),
    ];
    return Promise.all(
      rows.map(async ({ kind, config }): Promise<Candidate> => {
        const lib = String(config.libraryId);
        const problem = classifyCandidate(
          config,
          kind,
          libraryId ?? lib,
          groups,
          groupId
        );
        const subtype =
          kind === 'collection'
            ? (config as CollectionConfig).subtype
            : undefined;
        return {
          key: memberKey(kind, config.id),
          kind,
          configId: config.id,
          name: config.name,
          libraryId: lib,
          libraryName: config.libraryName,
          type:
            kind === 'collection'
              ? (config as CollectionConfig).type
              : 'preExisting',
          ...(subtype ? { subtype } : {}),
          posterUrl: await this.posterFor(config.collectionRatingKey, 0, ctx),
          selectable: !problem,
          ...(problem
            ? { reason: problem.reason, reasonDetail: problem.reasonDetail }
            : {}),
        };
      })
    );
  }

  private findMember(kind: MemberKind, configId: string) {
    for (const group of this.validGroups()) {
      const member = group.members.find(
        (m) => m.kind === kind && m.configId === configId
      );
      if (member) return { group, member };
    }
    return undefined;
  }

  private membershipOf(
    group: RotationGroup,
    member: RotationMember
  ): Membership {
    const idx = group.state.slots.findIndex((s) => s.occupant === member.key);
    return {
      groupId: group.id,
      groupName: group.name,
      showing: idx >= 0,
      ...(idx >= 0 ? { slotIndex: idx } : {}),
      slotCount: group.slotCount,
      surfaces: group.surfaces,
      own: member.own ?? null,
    };
  }

  public getMembershipMap(): MembershipMap {
    const map: MembershipMap = {};
    for (const group of this.validGroups()) {
      for (const member of group.members) {
        map[member.key] = this.membershipOf(group, member);
      }
    }
    return map;
  }

  /** Writes the stash only. Throws RotationNotFoundError when not a member. */
  public patchOwn(
    kind: MemberKind,
    configId: string,
    patch: OwnSettingsPatch
  ): Membership {
    const found = this.findMember(kind, configId);
    if (!found) throw new RotationNotFoundError('Not part of a rotation.');
    const { group, member } = found;
    const config = this.memberConfig(member);

    if (!group.enabled) {
      if (!config) return this.membershipOf(group, member);
      const own = captureOwn(config, new Date());
      const merged = this.mergeOwn(own, patch);
      restoreFields(config, merged);
      getSettings().save();
      return this.membershipOf(group, member);
    }

    if (!member.own) {
      throw new RotationNotFoundError('No saved settings for this member.');
    }
    const merged = this.mergeOwn(member.own, patch);
    if (JSON.stringify(merged) !== JSON.stringify(member.own)) {
      member.own = merged;
      getSettings().save();
    }
    return this.membershipOf(group, member);
  }

  private mergeOwn(
    own: RotationOwnSettings,
    patch: OwnSettingsPatch
  ): RotationOwnSettings {
    const defined = <T extends object>(v: T | undefined): Partial<T> =>
      Object.fromEntries(
        Object.entries(v ?? {}).filter(([, x]) => x !== undefined)
      ) as Partial<T>;
    return {
      ...own,
      ...(patch.visibilityConfig
        ? {
            visibilityConfig: {
              ...own.visibilityConfig,
              ...defined(patch.visibilityConfig),
            },
          }
        : {}),
      ...(patch.inactiveVisibilityConfig
        ? {
            inactiveVisibilityConfig: {
              ...(own.inactiveVisibilityConfig ?? ALL_HIDDEN),
              ...defined(patch.inactiveVisibilityConfig),
            },
          }
        : {}),
      ...(patch.randomizeHomeOrder !== undefined
        ? { randomizeHomeOrder: patch.randomizeHomeOrder }
        : {}),
    };
  }

  /** Copy of the config with the member's own values substituted; identity for non-members. */
  public withOwnSettings<T extends MemberConfig>(
    config: T,
    kind: MemberKind
  ): T {
    if (!this.hasGroups()) return config;
    const found = this.findMember(kind, config.id);
    if (!found || !found.group.enabled || !found.member.own) return config;
    const copy = clone(config);
    restoreFields(copy, found.member.own);
    return copy;
  }

  public isMemberRatingKey(ratingKey: string): boolean {
    return this.validGroups().some((g) =>
      g.members.some(
        (m) =>
          m.ratingKey === ratingKey ||
          this.memberConfig(m)?.collectionRatingKey === ratingKey
      )
    );
  }
}

export const rotationGroupService = new RotationGroupService();
export default rotationGroupService;

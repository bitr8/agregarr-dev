import type {
  Eligibility,
  LocalParts,
  MemberKey,
  NextChangeKind,
  PlanEvent,
  PlanInput,
  PlanResult,
  RotationInterval,
  RotationSlot,
  RotationState,
} from './types';

const HOUR_MS = 3600000;
const SEARCH_HOURS = 24 * 45;
const STORED_KEY = /^(sync:.+|\d{4}-\d{2}(-\d{2}[ap]?)?)$/;
const KEY_FORMAT: Record<RotationInterval, RegExp> = {
  every_sync: /^sync:.+$/,
  '12h': /^\d{4}-\d{2}-\d{2}[ap]$/,
  daily: /^\d{4}-\d{2}-\d{2}$/,
  weekly: /^\d{4}-\d{2}-\d{2}$/,
  monthly_random: /^\d{4}-\d{2}$/,
};

/** Same group and cycle always shuffle the same way, so a dry run matches the real pass. */
function seededRng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

const p2 = (n: number): string => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number): string =>
  `${y}-${p2(m)}-${p2(d)}`;
const monthKey = (parts: LocalParts): string => `${parts.y}-${p2(parts.m)}`;
const cloneState = (s: RotationState): RotationState =>
  JSON.parse(JSON.stringify(s)) as RotationState;
const isWeekday = (n: number | undefined): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 6;

export function periodKey(
  interval: RotationInterval,
  weekday: number | undefined,
  parts: LocalParts,
  syncRunId: string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _state: RotationState
): string | null {
  switch (interval) {
    case 'every_sync':
      return syncRunId ? `sync:${syncRunId}` : null;
    case '12h':
      return `${ymd(parts.y, parts.m, parts.d)}${parts.hour < 12 ? 'a' : 'p'}`;
    case 'daily':
      return ymd(parts.y, parts.m, parts.d);
    case 'weekly': {
      const back = (parts.dow - (isWeekday(weekday) ? weekday : 1) + 7) % 7;
      const t = new Date(Date.UTC(parts.y, parts.m - 1, parts.d - back));
      return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    }
    case 'monthly_random':
      return monthKey(parts);
    default:
      return null;
  }
}

/** First instant after `from` where `pred` holds, assuming it does not hold at `from`. */
function firstInstant(
  from: Date,
  toLocal: (d: Date) => LocalParts,
  pred: (parts: LocalParts) => boolean
): Date | undefined {
  const start = from.getTime();
  for (let i = 1; i <= SEARCH_HOURS; i++) {
    const t = start + i * HOUR_MS;
    if (pred(toLocal(new Date(t)))) {
      let lo = t - HOUR_MS;
      let hi = t;
      while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (pred(toLocal(new Date(mid)))) hi = mid;
        else lo = mid;
      }
      return new Date(hi);
    }
  }
  return undefined;
}

export function nextBoundary(
  interval: RotationInterval,
  weekday: number | undefined,
  now: Date,
  toLocal: (d: Date) => LocalParts,
  state: RotationState
): { kind: NextChangeKind; notBefore?: Date } {
  if (interval === 'every_sync') return { kind: 'every_sync' };
  const parts = toLocal(now);

  if (interval === 'monthly_random') {
    const cur = monthKey(parts);
    if (state.periodKey === null || state.periodKey === cur) {
      return { kind: 'monthly_done' };
    }
    const day = state.monthly?.month === cur ? state.monthly.day : undefined;
    if (day === undefined || day <= parts.d) {
      return { kind: 'boundary', notBefore: new Date(now.getTime()) };
    }
    const at = firstInstant(
      now,
      toLocal,
      (p) => monthKey(p) === cur && p.d >= day
    );
    return { kind: 'boundary', notBefore: at ?? new Date(now.getTime()) };
  }

  const key = (p: LocalParts) =>
    periodKey(interval, weekday, p, undefined, state);
  const k0 = key(parts);
  if (
    typeof state.periodKey === 'string' &&
    STORED_KEY.test(state.periodKey) &&
    state.periodKey !== k0
  ) {
    return { kind: 'boundary', notBefore: new Date(now.getTime()) };
  }
  const at = firstInstant(now, toLocal, (p) => key(p) !== k0);
  return { kind: 'boundary', notBefore: at };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const occupancy = (slots: RotationSlot[]): string =>
  slots
    .filter((s) => s.occupant)
    .map((s) => `${s.id}=${s.occupant}`)
    .join(',');

export function planRotation(input: PlanInput): PlanResult {
  const { group, eligibility, now, toLocal, rng, syncRunId, force } = input;
  const before = group.state;
  const state = cloneState(before);
  const events: PlanEvent[] = [];
  const parts = toLocal(now);
  const nowIso = now.toISOString();
  const slotCount = group.slotCount;

  const memberSet = new Set<MemberKey>(group.members.map((m) => m.key));
  const elig = (k: MemberKey): Eligibility => eligibility[k] ?? 'ok';
  const okSet = new Set<MemberKey>(
    group.members.filter((m) => elig(m.key) === 'ok').map((m) => m.key)
  );
  const origOccupant = new Map(
    before.slots.map((s) => [s.id, s.occupant] as const)
  );

  // 1. sanitise
  const notes: string[] = [];
  const kept = state.slots.slice(0, slotCount);
  const dropped = state.slots.slice(slotCount);
  if (dropped.length) notes.push(`removed ${dropped.length} slots`);
  const showing = new Set<MemberKey>();
  for (const slot of kept) {
    if (slot.occupant === null) continue;
    if (!memberSet.has(slot.occupant) || showing.has(slot.occupant)) {
      notes.push(`cleared ${slot.id}`);
      slot.occupant = null;
      delete slot.since;
    } else {
      showing.add(slot.occupant);
    }
  }
  const queue: MemberKey[] = [];
  const queued = new Set<MemberKey>();
  const enqueue = (k: MemberKey) => {
    if (memberSet.has(k) && !showing.has(k) && !queued.has(k)) {
      queued.add(k);
      queue.push(k);
    }
  };
  for (const k of state.queue) enqueue(k);
  if (queue.length !== state.queue.length) notes.push('repaired queue');
  for (const slot of dropped) if (slot.occupant) enqueue(slot.occupant);
  for (const m of group.members) enqueue(m.key);
  const slots = kept;
  const usedIds = new Set(state.slots.map((s) => s.id));
  while (slots.length < slotCount) {
    let n = slots.length + 1;
    while (usedIds.has(`s${n}`)) n++;
    const id = `s${n}`;
    usedIds.add(id);
    const maxPos = slots.reduce((a, s) => Math.max(a, s.sortOrderHome), 0);
    slots.push({ id, occupant: null, sortOrderHome: maxPos + 1 });
  }
  const shown: MemberKey[] = [];
  for (const k of state.shownThisCycle) {
    if (memberSet.has(k) && !shown.includes(k)) shown.push(k);
  }
  if (notes.length)
    events.push({ type: 'sanitised', detail: notes.join('; ') });

  // 2. monthly draw
  const curMonth = monthKey(parts);
  if (
    group.interval === 'monthly_random' &&
    state.monthly?.month !== curMonth
  ) {
    const day = 1 + Math.floor(rng() * parts.daysInMonth);
    state.monthly = { month: curMonth, day };
    events.push({ type: 'monthly_day_drawn', month: curMonth, day });
  }

  // 3. due?
  const key = periodKey(group.interval, group.weekday, parts, syncRunId, state);
  const stored = before.periodKey;
  const storedUsable =
    typeof stored === 'string' &&
    (KEY_FORMAT[group.interval] ?? STORED_KEY).test(stored);
  let due = false;
  if (force) {
    due = true;
  } else if (key !== null && storedUsable && key !== stored) {
    due =
      group.interval !== 'monthly_random' ||
      parts.d >= Math.min(state.monthly?.day ?? Infinity, parts.daysInMonth);
  } else if (
    group.interval === 'every_sync' &&
    key !== null &&
    !storedUsable &&
    before.slots.some((s) => s.occupant)
  ) {
    // Filled outside a sync (create, rotate now): the first sync is a new period.
    due = true;
  }
  const rotating = due && okSet.size > slotCount;
  if (rotating) {
    const outgoing: MemberKey[] = [];
    for (const slot of slots) {
      if (slot.occupant) {
        outgoing.push(slot.occupant);
        queue.push(slot.occupant);
        slot.occupant = null;
      }
    }
    events.push({ type: 'rotated', outgoing, incoming: [] });
  }

  // 4. repair
  for (const slot of slots) {
    if (slot.occupant && !okSet.has(slot.occupant)) {
      events.push({
        type: 'repaired',
        slotId: slot.id,
        outgoing: slot.occupant,
        reason: elig(slot.occupant),
      });
      queue.push(slot.occupant);
      slot.occupant = null;
    }
  }

  // 5. fill
  const incoming: MemberKey[] = [];
  for (const slot of slots) {
    if (slot.occupant) continue;
    const idx = queue.findIndex((k) => okSet.has(k));
    if (idx === -1) continue;
    const [k] = queue.splice(idx, 1);
    slot.occupant = k;
    incoming.push(k);
    if (!shown.includes(k)) shown.push(k);
    if (!rotating)
      events.push({ type: 'filled', slotId: slot.id, incoming: k });
  }
  const rotatedEvent = events.find((e) => e.type === 'rotated');
  if (rotatedEvent && rotatedEvent.type === 'rotated') {
    rotatedEvent.incoming = incoming;
  }

  // 6. cycle end
  const occupants = slots
    .map((s) => s.occupant)
    .filter((k): k is MemberKey => k !== null);
  const occSet = new Set(occupants);
  let nextShown = shown;
  let nextQueue = queue;
  let cycle = state.cycle;
  if (
    okSet.size > 0 &&
    [...okSet].every((k) => shown.includes(k)) &&
    shown.some((k) => !occSet.has(k))
  ) {
    cycle += 1;
    nextShown = occupants.slice();
    events.push({ type: 'cycle_complete', cycle });
    if (group.order === 'shuffled') {
      const tail = Math.min(slotCount, queue.length);
      const head = queue.slice(0, queue.length - tail);
      nextQueue = [
        ...shuffle(head, seededRng(`${group.id}:${cycle}`)),
        ...queue.slice(queue.length - tail),
      ];
    }
  }

  // 7. commit
  state.slots = slots;
  state.queue = nextQueue;
  state.shownThisCycle = nextShown;
  state.cycle = cycle;
  for (const slot of slots) {
    if ((slot.occupant ?? null) !== (origOccupant.get(slot.id) ?? null)) {
      if (slot.occupant) slot.since = nowIso;
      else delete slot.since;
    }
  }
  if (occupancy(slots) !== occupancy(before.slots)) state.seq += 1;
  if (key !== null && (due || !storedUsable)) state.periodKey = key;
  if (rotating) state.lastRotatedAt = nowIso;

  return {
    state,
    changed: JSON.stringify(state) !== JSON.stringify(before),
    rotated: rotating,
    events,
  };
}

/** Repeated forced planRotation on copies; never mutates the input. */
export function simulate(input: PlanInput, steps: number): RotationState[] {
  const out: RotationState[] = [];
  let group = input.group;
  for (let i = 0; i < steps; i++) {
    const { state } = planRotation({ ...input, group, force: true });
    out.push(state);
    group = { ...group, state };
  }
  return out;
}

export function emptyState(): RotationState {
  return {
    seq: 0,
    appliedSeq: 0,
    periodKey: null,
    slots: [],
    queue: [],
    shownThisCycle: [],
    cycle: 1,
  };
}

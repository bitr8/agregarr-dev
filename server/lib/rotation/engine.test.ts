import { describe, expect, it } from 'vitest';
import {
  emptyState,
  nextBoundary,
  periodKey,
  planRotation,
  simulate,
} from './engine';
import type {
  Eligibility,
  LocalParts,
  MemberKey,
  PlanInput,
  RotationGroup,
  RotationInterval,
  RotationState,
} from './types';

const DAYS_IN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const toLocal = (d: Date): LocalParts => {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return {
    y,
    m,
    d: d.getUTCDate(),
    dow: d.getUTCDay(),
    hour: d.getUTCHours(),
    daysInMonth: m === 2 && leap ? 29 : DAYS_IN[m - 1],
  };
};

const lcg = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

const at = (iso: string) => new Date(iso);
const key = (n: number): MemberKey => `collection:cfg-${n}`;

const mkGroup = (
  memberCount: number,
  slotCount: number,
  extra: Partial<RotationGroup> = {}
): RotationGroup => ({
  id: 'grp-a',
  name: 'Group A',
  libraryId: 'lib-1',
  enabled: true,
  slotCount,
  interval: 'daily',
  order: 'sequential',
  surfaces: {
    usersHome: true,
    serverOwnerHome: true,
    libraryRecommended: false,
  },
  members: Array.from({ length: memberCount }, (_, i) => ({
    key: key(i + 1),
    kind: 'collection' as const,
    configId: `cfg-${i + 1}`,
    name: `Name ${i + 1}`,
    addedAt: '2026-01-01T00:00:00.000Z',
  })),
  state: emptyState(),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

const input = (
  group: RotationGroup,
  now: string,
  extra: Partial<PlanInput> = {}
): PlanInput => ({
  group,
  eligibility: {},
  now: at(now),
  toLocal,
  rng: lcg(42),
  ...extra,
});

const withState = (g: RotationGroup, state: RotationState): RotationGroup => ({
  ...g,
  state,
});

const occupants = (s: RotationState) => s.slots.map((x) => x.occupant);

const parts = (iso: string) => toLocal(at(iso));
const pk = (
  interval: RotationInterval,
  iso: string,
  weekday?: number,
  run?: string,
  everyWeeks?: number,
  anchor?: string
) =>
  periodKey(
    interval,
    weekday,
    parts(iso),
    run,
    emptyState(),
    everyWeeks,
    anchor
  );

describe('periodKey', () => {
  it.each([
    ['daily', '2026-03-10T23:59:00Z', undefined, '2026-03-10'],
    ['daily', '2026-03-11T00:01:00Z', undefined, '2026-03-11'],
    ['12h', '2026-03-10T11:59:00Z', undefined, '2026-03-10a'],
    ['12h', '2026-03-10T12:00:00Z', undefined, '2026-03-10p'],
    ['12h', '2026-03-10T23:59:00Z', undefined, '2026-03-10p'],
    ['12h', '2026-03-11T00:01:00Z', undefined, '2026-03-11a'],
    ['monthly_random', '2026-03-31T23:59:00Z', undefined, '2026-03'],
    ['monthly_random', '2026-04-01T00:01:00Z', undefined, '2026-04'],
    ['daily', '2026-02-28T23:59:00Z', undefined, '2026-02-28'],
    ['daily', '2026-03-01T00:01:00Z', undefined, '2026-03-01'],
    ['daily', '2028-02-29T12:00:00Z', undefined, '2028-02-29'],
  ] as const)('%s at %s weekday %s is %s', (interval, iso, wd, expected) => {
    expect(pk(interval, iso, wd)).toBe(expected);
  });

  it('weekly: Sunday to Monday with the default Monday', () => {
    expect(pk('weekly', '2026-03-15T23:59:00Z')).toBe('2026-03-09');
    expect(pk('weekly', '2026-03-16T00:01:00Z')).toBe('2026-03-16');
    expect(pk('weekly', '2026-03-16T00:01:00Z', undefined)).toBe('2026-03-16');
  });

  it.each([0, 1, 2, 3, 4, 5, 6])(
    'weekly with weekday %i changes exactly on that day',
    (wd) => {
      // 2026-03-15 is a Sunday (dow 0)
      const day = (n: number) =>
        `2026-03-${String(15 + n).padStart(2, '0')}T12:00:00Z`;
      const keys = Array.from({ length: 14 }, (_, i) =>
        pk('weekly', day(i), wd)
      );
      for (let i = 1; i < 14; i++) {
        const dow = (0 + i) % 7;
        expect(keys[i] !== keys[i - 1]).toBe(dow === wd);
      }
    }
  );

  it('weekly crosses a month and a year end', () => {
    expect(pk('weekly', '2026-03-02T12:00:00Z', 1)).toBe('2026-03-02');
    expect(pk('weekly', '2026-03-01T12:00:00Z', 1)).toBe('2026-02-23');
    expect(pk('weekly', '2027-01-01T12:00:00Z', 1)).toBe('2026-12-28');
  });

  it('weekly falls back to Monday on a bad weekday', () => {
    expect(pk('weekly', '2026-03-18T12:00:00Z', 9)).toBe('2026-03-16');
  });

  it('everyWeeks 1 or unset gives the exact key weekly always gave', () => {
    const start = Date.UTC(2025, 0, 1, 12);
    for (const wd of [0, 1, 2, 3, 4, 5, 6]) {
      for (let i = 0; i < 400; i++) {
        const iso = new Date(start + i * 86400000).toISOString();
        const p = parts(iso);
        const back = (p.dow - wd + 7) % 7;
        const t = new Date(Date.UTC(p.y, p.m - 1, p.d - back));
        const old = t.toISOString().slice(0, 10);
        expect(pk('weekly', iso, wd)).toBe(old);
        expect(pk('weekly', iso, wd, undefined, 1)).toBe(old);
      }
    }
  });

  it.each([2, 3, 4, 5, 6])(
    'weekly every %i weeks changes on the weekday at that spacing',
    (n) => {
      const start = Date.UTC(2026, 0, 1, 12);
      const changes: string[] = [];
      let prev = pk('weekly', new Date(start).toISOString(), 3, undefined, n);
      for (let i = 1; i < 7 * n * 8; i++) {
        const iso = new Date(start + i * 86400000).toISOString();
        const k = pk('weekly', iso, 3, undefined, n);
        if (k !== prev) {
          expect(parts(iso).dow).toBe(3);
          changes.push(iso.slice(0, 10));
          prev = k;
        }
        expect(pk('weekly', iso, 3, undefined, n)).toBe(k);
      }
      expect(changes.length).toBeGreaterThanOrEqual(7);
      for (let i = 1; i < changes.length; i++) {
        const gap =
          (Date.parse(changes[i]) - Date.parse(changes[i - 1])) / 86400000;
        expect(gap).toBe(7 * n);
      }
    }
  );

  it('weekly every 2 weeks holds the key for the second week', () => {
    const a = pk('weekly', '2026-03-16T12:00:00Z', 1, undefined, 2);
    const b = pk('weekly', '2026-03-23T12:00:00Z', 1, undefined, 2);
    const c = pk('weekly', '2026-03-30T12:00:00Z', 1, undefined, 2);
    expect(a).toBe(b);
    expect(c).not.toBe(b);
  });

  it('every_sync uses the run id and is null outside a sync', () => {
    expect(pk('every_sync', '2026-03-10T12:00:00Z', undefined, 'r1')).toBe(
      'sync:r1'
    );
    expect(pk('every_sync', '2026-03-10T12:00:00Z')).toBeNull();
  });
});

describe('nextBoundary', () => {
  const nb = (
    interval: RotationInterval,
    iso: string,
    weekday?: number,
    state = emptyState(),
    everyWeeks?: number
  ) => nextBoundary(interval, weekday, at(iso), toLocal, state, everyWeeks);

  it('every_sync has no date', () => {
    expect(nb('every_sync', '2026-03-10T12:00:00Z')).toEqual({
      kind: 'every_sync',
    });
  });

  it.each([
    ['daily', '2026-03-10T23:59:00Z', undefined, '2026-03-11T00:00:00.000Z'],
    ['daily', '2026-03-10T00:00:00Z', undefined, '2026-03-11T00:00:00.000Z'],
    ['12h', '2026-03-10T00:30:00Z', undefined, '2026-03-10T12:00:00.000Z'],
    ['12h', '2026-03-10T12:00:00Z', undefined, '2026-03-11T00:00:00.000Z'],
    ['weekly', '2026-03-15T10:00:00Z', undefined, '2026-03-16T00:00:00.000Z'],
    ['weekly', '2026-03-16T10:00:00Z', undefined, '2026-03-23T00:00:00.000Z'],
    ['weekly', '2026-03-16T10:00:00Z', 5, '2026-03-20T00:00:00.000Z'],
    ['daily', '2026-02-28T10:00:00Z', undefined, '2026-03-01T00:00:00.000Z'],
    ['daily', '2028-02-28T10:00:00Z', undefined, '2028-02-29T00:00:00.000Z'],
  ] as const)('%s from %s is %s', (interval, iso, wd, expected) => {
    const r = nb(interval, iso, wd);
    expect(r.kind).toBe('boundary');
    expect(r.notBefore?.toISOString()).toBe(expected);
  });

  it('weekly every 3 weeks lands three weeks after the bucket start', () => {
    const state = emptyState();
    const now = '2026-03-18T10:00:00Z';
    const k0 = pk('weekly', now, 1, undefined, 3);
    const r = nb('weekly', now, 1, state, 3);
    expect(r.kind).toBe('boundary');
    const boundary = r.notBefore as Date;
    expect(boundary.getUTCDay()).toBe(1);
    expect(boundary.getTime()).toBeGreaterThan(at(now).getTime());
    expect(pk('weekly', boundary.toISOString(), 1, undefined, 3)).not.toBe(k0);
    const before = new Date(boundary.getTime() - 1).toISOString();
    expect(pk('weekly', before, 1, undefined, 3)).toBe(k0);
    const gapDays =
      (boundary.getTime() - Date.parse(`${k0}T00:00:00Z`)) / 86400000;
    expect(gapDays).toBe(21);
  });

  it('is now when the group is already behind', () => {
    const state = { ...emptyState(), periodKey: '2026-03-09' };
    const r = nb('daily', '2026-03-10T10:00:00Z', undefined, state);
    expect(r.notBefore?.toISOString()).toBe('2026-03-10T10:00:00.000Z');
  });

  it('monthly: done after this month rotated, boundary on the drawn day otherwise', () => {
    const done = { ...emptyState(), periodKey: '2026-03' };
    expect(
      nb('monthly_random', '2026-03-10T10:00:00Z', undefined, done)
    ).toEqual({ kind: 'monthly_done' });
    const pending = {
      ...emptyState(),
      periodKey: '2026-02',
      monthly: { month: '2026-03', day: 20 },
    };
    const r = nb('monthly_random', '2026-03-10T10:00:00Z', undefined, pending);
    expect(r.kind).toBe('boundary');
    expect(r.notBefore?.toISOString()).toBe('2026-03-20T00:00:00.000Z');
  });
});

describe('planRotation basics', () => {
  it('fills slots from the queue on first run without rotating', () => {
    const g = mkGroup(8, 3);
    const r = planRotation(input(g, '2026-03-10T08:00:00Z'));
    expect(occupants(r.state)).toEqual([key(1), key(2), key(3)]);
    expect(r.rotated).toBe(false);
    expect(r.state.periodKey).toBe('2026-03-10');
    expect(r.state.seq).toBe(1);
    expect(r.state.queue).toEqual([4, 5, 6, 7, 8].map(key));
    expect(r.changed).toBe(true);
  });

  it('never mutates the input group or state', () => {
    const g = mkGroup(8, 3);
    const frozen = JSON.stringify(g);
    planRotation(input(g, '2026-03-10T08:00:00Z'));
    simulate(input(g, '2026-03-10T08:00:00Z'), 3);
    expect(JSON.stringify(g)).toBe(frozen);
  });

  it('a second run in the same period is a no-op with a deep-equal state', () => {
    const g = mkGroup(8, 3);
    const first = planRotation(input(g, '2026-03-10T08:00:00Z'));
    const second = planRotation(
      input(withState(g, first.state), '2026-03-10T20:00:00Z')
    );
    expect(second.changed).toBe(false);
    expect(second.rotated).toBe(false);
    expect(second.state).toEqual(first.state);
    expect(second.events).toEqual([]);
  });

  it('rotates when the period changes', () => {
    const g = mkGroup(8, 3);
    const first = planRotation(input(g, '2026-03-10T08:00:00Z'));
    const next = planRotation(
      input(withState(g, first.state), '2026-03-11T00:01:00Z')
    );
    expect(next.rotated).toBe(true);
    expect(occupants(next.state)).toEqual([key(4), key(5), key(6)]);
    expect(next.state.queue).toEqual([7, 8, 1, 2, 3].map(key));
    expect(next.state.periodKey).toBe('2026-03-11');
    expect(next.state.lastRotatedAt).toBe('2026-03-11T00:01:00.000Z');
    expect(next.state.seq).toBe(first.state.seq + 1);
  });

  it('every interval rotates across its own boundary and not before', () => {
    const cases: [
      RotationInterval,
      number | undefined,
      string,
      string,
      string
    ][] = [
      ['daily', undefined, '2026-03-10T23:59:00Z', '2026-03-11T00:01:00Z', 'r'],
      ['12h', undefined, '2026-03-10T11:59:00Z', '2026-03-10T12:00:00Z', 'r'],
      [
        'weekly',
        undefined,
        '2026-03-15T23:59:00Z',
        '2026-03-16T00:01:00Z',
        'r',
      ],
      ['weekly', 3, '2026-03-17T23:59:00Z', '2026-03-18T00:01:00Z', 'r'],
      ['daily', undefined, '2026-02-28T23:59:00Z', '2026-03-01T00:01:00Z', 'r'],
      [
        'every_sync',
        undefined,
        '2026-03-10T10:00:00Z',
        '2026-03-10T10:00:01Z',
        'r2',
      ],
    ];
    for (const [interval, weekday, before, after, run] of cases) {
      const g = mkGroup(8, 3, { interval, weekday });
      const a = planRotation(
        input(g, before, { syncRunId: interval === 'every_sync' ? 'r1' : run })
      );
      const same = planRotation(
        input(withState(g, a.state), before, {
          syncRunId: interval === 'every_sync' ? 'r1' : run,
        })
      );
      expect(same.rotated, `${interval} same period`).toBe(false);
      const later = planRotation(
        input(withState(g, a.state), after, { syncRunId: run })
      );
      expect(later.rotated, `${interval} next period`).toBe(true);
    }
  });

  it('every_sync outside a sync never rotates', () => {
    const g = mkGroup(8, 3, { interval: 'every_sync' });
    const a = planRotation(
      input(g, '2026-03-10T10:00:00Z', { syncRunId: 'r1' })
    );
    const b = planRotation(
      input(withState(g, a.state), '2026-03-12T10:00:00Z')
    );
    expect(b.rotated).toBe(false);
    expect(b.changed).toBe(false);
  });

  it('every_sync filled outside a sync rotates at its first sync', () => {
    const g = mkGroup(8, 3, { interval: 'every_sync' });
    const created = planRotation(input(g, '2026-03-10T10:00:00Z'));
    expect(created.rotated).toBe(false);
    expect(created.state.periodKey).toBeNull();
    const first = planRotation(
      input(withState(g, created.state), '2026-03-10T11:00:00Z', {
        syncRunId: 'r1',
      })
    );
    expect(first.rotated).toBe(true);
    expect(occupants(first.state)).not.toEqual(occupants(created.state));
    const again = planRotation(
      input(withState(g, first.state), '2026-03-10T11:05:00Z', {
        syncRunId: 'r1',
      })
    );
    expect(again.changed).toBe(false);
  });

  it('a stored key from another interval is adopted, not rotated on', () => {
    const g = mkGroup(8, 3, { interval: 'every_sync' });
    const a = planRotation(
      input(g, '2026-03-10T10:00:00Z', { syncRunId: 'r1' })
    );
    const b = planRotation(
      input(withState(g, a.state), '2026-03-10T11:00:00Z', { syncRunId: 'r2' })
    );
    expect(b.state.periodKey).toBe('sync:r2');
    const daily = { ...g, interval: 'daily' as const };
    const c = planRotation(
      input(withState(daily, b.state), '2026-03-10T12:00:00Z', {
        syncRunId: 'r3',
      })
    );
    expect(c.rotated).toBe(false);
    expect(c.state.periodKey).toBe('2026-03-10');
    expect(occupants(c.state)).toEqual(occupants(b.state));
    const d = planRotation(
      input(withState(daily, c.state), '2026-03-11T00:30:00Z', {
        syncRunId: 'r4',
      })
    );
    expect(d.rotated).toBe(true);
  });

  it('monthly day beyond the month length still rotates on the last day', () => {
    const g = mkGroup(8, 3, { interval: 'monthly_random' });
    const filled = planRotation(input(g, '2026-03-10T10:00:00Z')).state;
    const state = {
      ...filled,
      periodKey: '2026-03',
      monthly: { month: '2026-04', day: 31 },
    };
    const r = planRotation(input(withState(g, state), '2026-04-30T10:00:00Z'));
    expect(r.rotated).toBe(true);
    expect(r.state.periodKey).toBe('2026-04');
  });

  it('shuffled: a dry run across the cycle boundary matches the real passes whatever rng is injected', () => {
    const g = mkGroup(8, 3, { order: 'shuffled' });
    const start = planRotation(input(g, '2026-03-10T10:00:00Z')).state;
    const dry = simulate(
      input(withState(g, start), '2026-03-10T10:00:00Z', { rng: () => 0.1 }),
      6
    );
    let real = start;
    for (let i = 0; i < 6; i++) {
      real = planRotation(
        input(withState(g, real), '2026-03-10T10:00:00Z', {
          force: true,
          rng: () => 0.9,
        })
      ).state;
      expect(occupants(real), `step ${i}`).toEqual(occupants(dry[i]));
      expect(real.queue, `queue ${i}`).toEqual(dry[i].queue);
    }
  });

  it('every_sync with empty slots fills without rotating', () => {
    const g = mkGroup(8, 3, { interval: 'every_sync' });
    const first = planRotation(
      input(g, '2026-03-10T10:00:00Z', { syncRunId: 'r1' })
    );
    expect(first.rotated).toBe(false);
    expect(occupants(first.state)).toEqual([key(1), key(2), key(3)]);
  });

  it('force rotates inside the period', () => {
    const g = mkGroup(8, 3);
    const a = planRotation(input(g, '2026-03-10T08:00:00Z'));
    const f = planRotation(
      input(withState(g, a.state), '2026-03-10T09:00:00Z', { force: true })
    );
    expect(f.rotated).toBe(true);
    expect(occupants(f.state)).toEqual([4, 5, 6].map(key));
  });

  it('a malformed or null stored key is treated as current', () => {
    const g = mkGroup(8, 3);
    const a = planRotation(input(g, '2026-03-10T08:00:00Z'));
    for (const bad of [null, 'garbage', 42 as unknown as string]) {
      const r = planRotation(
        input(
          withState(g, { ...a.state, periodKey: bad }),
          '2026-03-11T08:00:00Z'
        )
      );
      expect(r.rotated).toBe(false);
      expect(r.state.periodKey).toBe('2026-03-11');
      expect(occupants(r.state)).toEqual(occupants(a.state));
    }
  });
});

describe('cycle before repeat', () => {
  it('37 members, 5 slots, 8 forced rotations: nobody repeats before everyone has shown', () => {
    const g = mkGroup(37, 5);
    let state = planRotation(input(g, '2026-03-10T08:00:00Z')).state;
    const appearances: MemberKey[] = [...(occupants(state) as MemberKey[])];
    for (let i = 0; i < 8; i++) {
      const r = planRotation(
        input(withState(g, state), '2026-03-10T08:00:00Z', { force: true })
      );
      expect(r.rotated).toBe(true);
      state = r.state;
      appearances.push(...(occupants(state) as MemberKey[]));
    }
    expect(appearances).toHaveLength(45);
    expect(new Set(appearances.slice(0, 37)).size).toBe(37);
    for (const k of appearances.slice(37)) {
      expect(appearances.slice(0, 37)).toContain(k);
    }
    expect(state.cycle).toBe(2);
  });

  it('every member has been shown after ceil(37/5) = 8 batches', () => {
    const g = mkGroup(37, 5);
    const states = simulate(input(g, '2026-03-10T08:00:00Z'), 9);
    const seen = new Set<MemberKey>();
    for (const s of states.slice(0, 8)) {
      for (const o of occupants(s)) if (o) seen.add(o);
    }
    expect(seen.size).toBe(37);
  });

  it('shuffled order: the last batch of a cycle is not the first batch of the next', () => {
    const g = mkGroup(37, 5, { order: 'shuffled' });
    let state = planRotation(input(g, '2026-03-10T08:00:00Z')).state;
    let guard = 0;
    while (state.cycle === 1 && guard++ < 20) {
      state = planRotation(
        input(withState(g, state), '2026-03-10T08:00:00Z', {
          force: true,
          rng: lcg(guard),
        })
      ).state;
    }
    expect(state.cycle).toBe(2);
    const lastBatch = new Set(occupants(state));
    const previousBatch = state.queue.slice(-5);
    const next = planRotation(
      input(withState(g, state), '2026-03-10T08:00:00Z', {
        force: true,
        rng: lcg(777),
      })
    );
    for (const o of occupants(next.state)) {
      expect(lastBatch.has(o as MemberKey)).toBe(false);
      expect(previousBatch).not.toContain(o);
    }
  });

  it('sequential order keeps the queue FIFO across a cycle end', () => {
    const g = mkGroup(7, 3);
    const states = simulate(input(g, '2026-03-10T08:00:00Z'), 4);
    expect(occupants(states[0])).toEqual([1, 2, 3].map(key));
    expect(occupants(states[1])).toEqual([4, 5, 6].map(key));
    expect(occupants(states[2])).toEqual([7, 1, 2].map(key));
  });
});

describe('small pools', () => {
  it.each([
    [5, 5],
    [3, 5],
  ])(
    'pool of %i with %i slots: no churn, period key still advances',
    (n, s) => {
      const g = mkGroup(n, s);
      const a = planRotation(input(g, '2026-03-10T08:00:00Z'));
      const b = planRotation(
        input(withState(g, a.state), '2026-03-11T08:00:00Z')
      );
      expect(b.rotated).toBe(false);
      expect(occupants(b.state)).toEqual(occupants(a.state));
      expect(b.state.seq).toBe(a.state.seq);
      expect(b.state.periodKey).toBe('2026-03-11');
      expect(b.state.lastRotatedAt).toBeUndefined();
      const c = planRotation(
        input(withState(g, b.state), '2026-03-11T09:00:00Z')
      );
      expect(c.changed).toBe(false);
      const forced = planRotation(
        input(withState(g, b.state), '2026-03-11T09:00:00Z', { force: true })
      );
      expect(forced.rotated).toBe(false);
      expect(occupants(forced.state)).toEqual(occupants(a.state));
    }
  );

  it('leaves surplus slots empty', () => {
    const g = mkGroup(3, 5);
    const a = planRotation(input(g, '2026-03-10T08:00:00Z'));
    expect(occupants(a.state)).toEqual([key(1), key(2), key(3), null, null]);
  });
});

describe('slot count changes', () => {
  it('slots raised: new slots follow the last position and fill at once without a rotation', () => {
    const g = mkGroup(10, 3);
    const a = planRotation(input(g, '2026-03-10T08:00:00Z'));
    const grown = withState(
      { ...g, slotCount: 5 },
      {
        ...a.state,
        slots: a.state.slots.map((s, i) => ({ ...s, sortOrderHome: 10 + i })),
      }
    );
    const b = planRotation(input(grown, '2026-03-10T09:00:00Z'));
    expect(b.rotated).toBe(false);
    expect(occupants(b.state)).toEqual([1, 2, 3, 4, 5].map(key));
    expect(b.state.slots.map((s) => s.sortOrderHome)).toEqual([
      10, 11, 12, 13, 14,
    ]);
    expect(b.state.slots.map((s) => s.id)).toEqual([
      's1',
      's2',
      's3',
      's4',
      's5',
    ]);
    expect(b.state.periodKey).toBe('2026-03-10');
    expect(b.state.seq).toBe(a.state.seq + 1);
  });

  it('slots lowered: trailing occupants go to the back of the queue', () => {
    const g = mkGroup(10, 5);
    const a = planRotation(input(g, '2026-03-10T08:00:00Z'));
    const b = planRotation(
      input(withState({ ...g, slotCount: 3 }, a.state), '2026-03-10T09:00:00Z')
    );
    expect(occupants(b.state)).toEqual([1, 2, 3].map(key));
    expect(b.state.slots).toHaveLength(3);
    expect(b.state.queue).toEqual([6, 7, 8, 9, 10, 4, 5].map(key));
    expect(b.rotated).toBe(false);
  });
});

describe('membership changes', () => {
  it('member added mid-cycle joins the back of the queue and the cycle waits for it', () => {
    const g = mkGroup(7, 3);
    const a = planRotation(input(g, '2026-03-10T08:00:00Z'));
    const bigger = mkGroup(8, 3, { state: a.state });
    const b = planRotation(input(bigger, '2026-03-10T09:00:00Z'));
    expect(b.state.queue).toEqual([4, 5, 6, 7, 8].map(key));
    expect(b.changed).toBe(true);
    expect(occupants(b.state)).toEqual(occupants(a.state));
  });

  it('member removed while showing: its slot is repaired from the queue', () => {
    const g = mkGroup(8, 3);
    const a = planRotation(input(g, '2026-03-10T08:00:00Z'));
    const smaller = {
      ...g,
      state: a.state,
      members: g.members.filter((m) => m.key !== key(2)),
    };
    const b = planRotation(input(smaller, '2026-03-10T09:00:00Z'));
    expect(occupants(b.state)).toEqual([key(1), key(4), key(3)]);
    expect(b.state.queue).not.toContain(key(2));
    expect(b.state.shownThisCycle).not.toContain(key(2));
    expect(b.rotated).toBe(false);
    expect(b.state.periodKey).toBe('2026-03-10');
    expect(b.state.seq).toBe(a.state.seq + 1);
  });

  it('removed member mid-queue is dropped from the queue', () => {
    const g = mkGroup(8, 3);
    const a = planRotation(input(g, '2026-03-10T08:00:00Z'));
    const smaller = {
      ...g,
      state: a.state,
      members: g.members.filter((m) => m.key !== key(6)),
    };
    const b = planRotation(input(smaller, '2026-03-10T09:00:00Z'));
    expect(b.state.queue).toEqual([4, 5, 7, 8].map(key));
  });
});

describe('eligibility', () => {
  const elig = (map: Record<number, Eligibility>) =>
    Object.fromEntries(
      Object.entries(map).map(([n, v]) => [key(Number(n)), v])
    );

  it('an ineligible member at the front is skipped, keeps its place, and shows once eligible', () => {
    const g = mkGroup(8, 3);
    const a = planRotation(input(g, '2026-03-10T08:00:00Z'));
    const b = planRotation(
      input(withState(g, a.state), '2026-03-11T08:00:00Z', {
        eligibility: elig({ 4: 'outside_schedule' }),
      })
    );
    expect(occupants(b.state)).toEqual([5, 6, 7].map(key));
    expect(b.state.queue[0]).toBe(key(4));
    const c = planRotation(
      input(withState(g, b.state), '2026-03-12T08:00:00Z')
    );
    expect(occupants(c.state)).toEqual([4, 8, 1].map(key));
  });

  it('a showing member that turns ineligible mid-period changes only its slot', () => {
    const g = mkGroup(8, 3);
    const a = planRotation(input(g, '2026-03-10T08:00:00Z'));
    const b = planRotation(
      input(withState(g, a.state), '2026-03-10T14:00:00Z', {
        eligibility: elig({ 2: 'not_in_plex' }),
      })
    );
    expect(b.rotated).toBe(false);
    expect(occupants(b.state)).toEqual([key(1), key(4), key(3)]);
    expect(b.state.periodKey).toBe('2026-03-10');
    expect(b.state.queue.at(-1)).toBe(key(2));
    expect(b.events.some((e) => e.type === 'repaired')).toBe(true);
    expect(b.state.slots[0].since).toBe(a.state.slots[0].since);
    expect(b.state.slots[1].since).toBe('2026-03-10T14:00:00.000Z');
  });

  it('ineligible members do not count toward the pool', () => {
    const g = mkGroup(4, 3);
    const a = planRotation(input(g, '2026-03-10T08:00:00Z'));
    const b = planRotation(
      input(withState(g, a.state), '2026-03-11T08:00:00Z', {
        eligibility: elig({ 4: 'unbound' }),
      })
    );
    expect(b.rotated).toBe(false);
    expect(occupants(b.state)).toEqual(occupants(a.state));
  });
});

describe('monthly_random', () => {
  const mg = () => mkGroup(8, 3, { interval: 'monthly_random' });

  it('the creation month counts as rotated and the day is stable across passes', () => {
    const a = planRotation(input(mg(), '2026-03-10T08:00:00Z'));
    expect(a.rotated).toBe(false);
    expect(a.state.periodKey).toBe('2026-03');
    expect(a.state.monthly?.month).toBe('2026-03');
    const day = a.state.monthly?.day;
    for (const iso of [
      '2026-03-12T08:00:00Z',
      '2026-03-28T08:00:00Z',
      '2026-03-31T23:00:00Z',
    ]) {
      const r = planRotation(
        input(withState(mg(), a.state), iso, { rng: lcg(999) })
      );
      expect(r.rotated).toBe(false);
      expect(r.state.monthly?.day).toBe(day);
      expect(r.changed).toBe(false);
    }
  });

  it('draws once per month from [1, daysInMonth] and rotates on or after the drawn day only', () => {
    const a = planRotation(input(mg(), '2026-03-10T08:00:00Z'));
    const fixedHigh = () => 0.99;
    const april1 = planRotation(
      input(withState(mg(), a.state), '2026-04-01T00:05:00Z', {
        rng: fixedHigh,
      })
    );
    expect(april1.state.monthly).toEqual({ month: '2026-04', day: 30 });
    expect(april1.rotated).toBe(false);
    expect(april1.state.periodKey).toBe('2026-03');
    const april29 = planRotation(
      input(withState(mg(), april1.state), '2026-04-29T08:00:00Z', {
        rng: lcg(5),
      })
    );
    expect(april29.rotated).toBe(false);
    expect(april29.state.monthly?.day).toBe(30);
    const april30 = planRotation(
      input(withState(mg(), april1.state), '2026-04-30T00:00:00Z')
    );
    expect(april30.rotated).toBe(true);
    expect(april30.state.periodKey).toBe('2026-04');
    const again = planRotation(
      input(withState(mg(), april30.state), '2026-04-30T12:00:00Z')
    );
    expect(again.changed).toBe(false);
  });

  it('a low draw rotates on the first sync of the month and February is 28 or 29 days', () => {
    const a = planRotation(input(mg(), '2026-01-10T08:00:00Z'));
    const feb = planRotation(
      input(withState(mg(), a.state), '2026-02-01T00:05:00Z', {
        rng: () => 0.9999,
      })
    );
    expect(feb.state.monthly?.day).toBe(28);
    const leap = planRotation(
      input(withState(mg(), a.state), '2028-02-01T00:05:00Z', {
        rng: () => 0.9999,
      })
    );
    expect(leap.state.monthly?.day).toBe(29);
    const low = planRotation(
      input(withState(mg(), a.state), '2026-02-01T00:05:00Z', { rng: () => 0 })
    );
    expect(low.state.monthly?.day).toBe(1);
    expect(low.rotated).toBe(true);
  });
});

describe('simulate', () => {
  it('step one equals the next real forced rotation', () => {
    const g = mkGroup(37, 5, { order: 'shuffled' });
    const a = planRotation(input(g, '2026-03-10T08:00:00Z'));
    const grp = withState(g, a.state);
    const sim = simulate(
      input(grp, '2026-03-10T09:00:00Z', { rng: lcg(3) }),
      1
    );
    const real = planRotation(
      input(grp, '2026-03-10T09:00:00Z', { force: true, rng: lcg(3) })
    );
    expect(sim).toHaveLength(1);
    expect(sim[0]).toEqual(real.state);
  });

  it('later steps chain', () => {
    const g = mkGroup(10, 2);
    const sims = simulate(input(g, '2026-03-10T08:00:00Z'), 3);
    expect(sims.map(occupants)).toEqual([
      [1, 2].map(key),
      [3, 4].map(key),
      [5, 6].map(key),
    ]);
  });
});

describe('sanitise', () => {
  it('repairs duplicates, strangers and a wrong slot count', () => {
    const g = mkGroup(6, 3);
    const broken: RotationState = {
      ...emptyState(),
      periodKey: '2026-03-10',
      slots: [
        { id: 's1', occupant: key(1), sortOrderHome: 1 },
        { id: 's2', occupant: key(1), sortOrderHome: 2 },
        { id: 's3', occupant: 'collection:stranger', sortOrderHome: 3 },
        { id: 's4', occupant: key(5), sortOrderHome: 4 },
        { id: 's5', occupant: null, sortOrderHome: 5 },
      ],
      queue: [key(2), key(2), 'collection:gone', key(1), key(3)],
      shownThisCycle: [key(1), key(1), 'collection:gone'],
    };
    const r = planRotation(input(withState(g, broken), '2026-03-10T10:00:00Z'));
    expect(r.state.slots.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    const occ = occupants(r.state).filter(Boolean) as MemberKey[];
    expect(new Set(occ).size).toBe(occ.length);
    expect(occ.every((k) => g.members.some((m) => m.key === k))).toBe(true);
    const all = [...occ, ...r.state.queue];
    expect(new Set(all).size).toBe(6);
    expect(all.sort()).toEqual(g.members.map((m) => m.key).sort());
    expect(r.state.shownThisCycle.filter((k) => k === key(1))).toHaveLength(1);
    expect(r.state.shownThisCycle).not.toContain('collection:gone');
    expect(r.events.some((e) => e.type === 'sanitised')).toBe(true);
    expect(r.state.slots[1].occupant).not.toBeNull();
    const again = planRotation(
      input(withState(g, r.state), '2026-03-10T11:00:00Z')
    );
    expect(again.changed).toBe(false);
  });
});

describe('partial swap', () => {
  const step = (g: RotationGroup, day: number) => {
    const r = planRotation(
      input(g, `2026-03-${String(day).padStart(2, '0')}T10:00:00Z`)
    );
    return { r, g: withState(g, r.state) };
  };

  it('6 members in 5 slots changes exactly one slot', () => {
    let { g } = step(mkGroup(6, 5), 1);
    const before = occupants(g.state);
    const out = step(g, 2);
    g = out.g;
    const after = occupants(g.state);
    const changed = after.filter((k, i) => k !== before[i]);
    expect(changed).toHaveLength(1);
    expect(after[0]).toBe(key(6));
    expect(after.slice(1)).toEqual(before.slice(1));
    expect(g.state.queue).toEqual([key(1)]);
    const ev = out.r.events.find((e) => e.type === 'rotated');
    expect(ev).toEqual({
      type: 'rotated',
      outgoing: [key(1)],
      incoming: [key(6)],
    });
  });

  it('10 members in 5 slots still changes every slot', () => {
    let { g } = step(mkGroup(10, 5), 1);
    const before = occupants(g.state);
    g = step(g, 2).g;
    const after = occupants(g.state);
    expect(after.every((k, i) => k !== before[i])).toBe(true);
  });

  it('the longest-seated slot leaves first, ties by slot index', () => {
    const g0 = mkGroup(7, 5);
    const state: RotationState = {
      ...emptyState(),
      periodKey: '2026-03-01',
      slots: [1, 2, 3, 4, 5].map((n) => ({
        id: `s${n}`,
        occupant: key(n),
        sortOrderHome: n,
        since:
          n === 3 ? '2026-02-01T00:00:00.000Z' : '2026-02-10T00:00:00.000Z',
      })),
      queue: [key(6), key(7)],
      shownThisCycle: [1, 2, 3, 4, 5].map(key),
    };
    const r = planRotation(input(withState(g0, state), '2026-03-02T10:00:00Z'));
    expect(occupants(r.state)).toEqual([
      key(6),
      key(2),
      key(7),
      key(4),
      key(5),
    ]);
    expect(r.state.queue).toEqual([key(3), key(1)]);
  });

  it('every member is shown before any repeats', () => {
    let { g } = step(mkGroup(8, 5), 1);
    const seen = new Set(occupants(g.state));
    for (let day = 2; day <= 4; day++) {
      g = step(g, day).g;
      for (const k of occupants(g.state)) seen.add(k);
    }
    expect(seen.size).toBe(8);
  });

  it('shuffled order still rotates a partial swap', () => {
    let { g } = step(mkGroup(6, 5, { order: 'shuffled' }), 1);
    const before = occupants(g.state);
    g = step(g, 2).g;
    const after = occupants(g.state);
    expect(after.filter((k, i) => k !== before[i])).toHaveLength(1);
    expect(new Set([...after, ...g.state.queue]).size).toBe(6);
  });
});

describe('every N weeks anchored to when it was set', () => {
  const changeDays = (
    from: string,
    days: number,
    wd: number,
    n: number,
    anchor?: string
  ) => {
    const start = Date.parse(`${from}T12:00:00Z`);
    const out: string[] = [];
    let prev = pk(
      'weekly',
      new Date(start).toISOString(),
      wd,
      undefined,
      n,
      anchor
    );
    for (let i = 1; i <= days; i++) {
      const iso = new Date(start + i * 86400000).toISOString();
      const k = pk('weekly', iso, wd, undefined, n, anchor);
      if (k !== prev) {
        expect(parts(iso).dow).toBe(wd);
        out.push(iso.slice(0, 10));
        prev = k;
      }
    }
    return out;
  };

  it('first change is N weeks after the anchor week, then every N weeks', () => {
    // set on Wednesday 2026-03-18, weekday Monday: anchor week starts 2026-03-16
    expect(changeDays('2026-03-18', 70, 1, 3, '2026-03-16')).toEqual([
      '2026-04-06',
      '2026-04-27',
      '2026-05-18',
    ]);
  });

  it('two groups set a week apart change in different weeks', () => {
    const a = changeDays('2026-03-11', 60, 1, 2, '2026-03-09');
    const b = changeDays('2026-03-18', 60, 1, 2, '2026-03-16');
    expect(a[0]).toBe('2026-03-23');
    expect(b[0]).toBe('2026-03-30');
    expect(a.some((d) => b.includes(d))).toBe(false);
  });

  it('a missing or malformed anchor falls back to the epoch blocks', () => {
    const base = changeDays('2026-03-11', 90, 1, 3);
    expect(changeDays('2026-03-11', 90, 1, 3, undefined)).toEqual(base);
    expect(changeDays('2026-03-11', 90, 1, 3, 'nope')).toEqual(base);
    expect(base).not.toEqual(changeDays('2026-03-11', 90, 1, 3, '2026-03-16'));
  });

  it('crosses a year end and a DST month on the chosen weekday', () => {
    expect(changeDays('2026-12-02', 90, 5, 4, '2026-11-27')).toEqual([
      '2026-12-25',
      '2027-01-22',
      '2027-02-19',
    ]);
    expect(changeDays('2026-03-20', 100, 0, 2, '2026-03-15')).toEqual([
      '2026-03-29',
      '2026-04-12',
      '2026-04-26',
      '2026-05-10',
      '2026-05-24',
      '2026-06-07',
      '2026-06-21',
    ]);
  });

  it('N of 1 ignores the anchor', () => {
    expect(
      pk('weekly', '2026-03-18T12:00:00Z', 1, undefined, 1, '2026-03-02')
    ).toBe(pk('weekly', '2026-03-18T12:00:00Z', 1));
  });

  it('nextBoundary reports the anchored change', () => {
    const state = { ...emptyState(), periodKey: '2026-03-16' };
    const b = nextBoundary(
      'weekly',
      1,
      at('2026-03-18T12:00:00Z'),
      toLocal,
      state,
      3,
      '2026-03-16'
    );
    expect(b.notBefore?.toISOString().slice(0, 10)).toBe('2026-04-06');
  });

  it('planRotation holds until the anchored week, then rotates', () => {
    const g = mkGroup(8, 5, {
      interval: 'weekly',
      weekday: 1,
      everyWeeks: 3,
      weeksAnchor: '2026-03-16',
    });
    const first = planRotation(input(g, '2026-03-18T10:00:00Z'));
    expect(first.state.periodKey).toBe('2026-03-16');
    const g2 = withState(g, first.state);
    expect(planRotation(input(g2, '2026-03-30T10:00:00Z')).rotated).toBe(false);
    expect(planRotation(input(g2, '2026-04-06T10:00:00Z')).rotated).toBe(true);
  });
});

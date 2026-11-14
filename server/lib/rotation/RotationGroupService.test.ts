import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

const state = vi.hoisted(() => ({
  settings: undefined as unknown,
  planFails: false,
}));
const kick = vi.hoisted(() => vi.fn());
const autoReorderLibrary = vi.hoisted(() =>
  vi.fn<(lib: string, ctx: string) => Promise<void>>(async () => undefined)
);

vi.mock('@server/lib/settings', async (importOriginal) => {
  const actual = (await importOriginal()) as { getSettings: () => unknown };
  return {
    ...actual,
    getSettings: () => state.settings ?? actual.getSettings(),
  };
});

vi.mock('@server/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@server/lib/metadata/MetadataTrackingService', () => ({
  default: { getPosterLocalPath: vi.fn(async () => null) },
}));

vi.mock('@server/lib/posterStorage', () => ({
  getPosterUrl: (f: string) => `/poster/${f}`,
}));

vi.mock('./rotationApply', () => ({
  rotationApply: { status: { running: false }, kick },
  default: { status: { running: false }, kick },
}));

vi.mock('@server/routes/reorder', () => ({ autoReorderLibrary }));

vi.mock('./engine', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof Engine;
  return {
    ...actual,
    planRotation: (input: PlanInput) => {
      if (state.planFails) throw new Error('planner failed');
      return actual.planRotation(input);
    },
  };
});

import type { GroupInput } from '@server/interfaces/api/rotationInterfaces';
import logger from '@server/logger';
import type * as Engine from './engine';
import { rotationGroupService as service } from './RotationGroupService';
import type { PlanInput, RotationGroup } from './types';

type Cfg = Record<string, unknown>;

const vis = (u: boolean, o: boolean, r: boolean) => ({
  usersHome: u,
  serverOwnerHome: o,
  libraryRecommended: r,
});

const pre = (n: number, extra: Cfg = {}): Cfg => ({
  id: `pre-${n}`,
  collectionRatingKey: `rk-${n}`,
  name: `Collection ${n}`,
  libraryId: 'lib-1',
  libraryName: 'Library One',
  mediaType: 'movie',
  sortOrderHome: n % 2 === 0 ? 0 : n,
  sortOrderLibrary: 0,
  isLibraryPromoted: false,
  visibilityConfig:
    n % 2 === 0 ? vis(false, false, false) : vis(true, true, false),
  isActive: true,
  collectionType: 'preexisting',
  ...extra,
});

const NOW = new Date(2026, 10, 14, 10, 0, 0);

interface Fixture {
  plex: {
    libraries: { key: string; name: string; type: string }[];
    preExistingCollectionConfigs: Cfg[];
    collectionConfigs: Cfg[];
    hubConfigs: Cfg[];
    rotationGroups?: RotationGroup[];
  };
  jobs: Record<string, { schedule: string }>;
  save: ReturnType<typeof vi.fn>;
}

const makeSettings = (count = 6): Fixture => ({
  plex: {
    libraries: [{ key: 'lib-1', name: 'Library One', type: 'movie' }],
    preExistingCollectionConfigs: Array.from({ length: count }, (_, i) =>
      pre(i + 1)
    ),
    collectionConfigs: [],
    hubConfigs: [],
  },
  jobs: { 'plex-collections-sync': { schedule: '0 0 */3 * * *' } },
  save: vi.fn(),
});

const settings = (): Fixture => state.settings as Fixture;
const snapshot = () => JSON.stringify(settings().plex);

const input = (over: Partial<GroupInput> = {}): GroupInput => ({
  name: 'Group One',
  libraryId: 'lib-1',
  enabled: true,
  slotCount: 2,
  interval: 'daily',
  order: 'sequential',
  surfaces: vis(true, true, false),
  members: [1, 2, 3, 4, 5, 6].map((n) => ({
    kind: 'preExisting' as const,
    configId: `pre-${n}`,
  })),
  ...over,
});

const cfg = (n: number) =>
  settings().plex.preExistingCollectionConfigs[n - 1] as Cfg;
const group = () => settings().plex.rotationGroups?.[0] as RotationGroup;

beforeEach(() => {
  state.settings = makeSettings();
  state.planFails = false;
  kick.mockClear();
  autoReorderLibrary.mockClear();
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.info).mockClear();
});

describe('feature off', () => {
  it('pass, hooks and helpers leave settings untouched and never save', async () => {
    const before = snapshot();
    expect(service.hasGroups()).toBe(false);
    expect(service.hasEnabledGroups()).toBe(false);
    expect(service.runPass({ syncRunId: 'run-1', now: NOW })).toEqual({
      changed: [],
      rotated: [],
      saved: false,
    });
    service.reassertManagedFields();
    service.markApplied();
    service.onCollectionDeleted('pre-1');
    await service.settlePositions();
    expect(service.withOwnSettings(cfg(1) as never, 'preExisting')).toBe(
      cfg(1)
    );
    expect(service.getMembershipMap()).toEqual({});
    expect(snapshot()).toBe(before);
    expect(settings().save).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(autoReorderLibrary).not.toHaveBeenCalled();
  });

  it('a disabled-only install is not an enabled group (schedule gate predicate)', async () => {
    await service.createGroup(input({ enabled: false }));
    expect(service.hasGroups()).toBe(true);
    expect(service.hasEnabledGroups()).toBe(false);
    await service.updateGroup(group().id, input({ enabled: true }));
    expect(service.hasEnabledGroups()).toBe(true);
  });

  it('create then delete the only group restores the serialised settings exactly', async () => {
    const before = snapshot();
    await service.createGroup(input());
    expect(snapshot()).not.toBe(before);
    service.deleteGroup(group().id);
    expect(snapshot()).toBe(before);
    expect(settings().plex.rotationGroups).toBeUndefined();
    expect('rotationGroups' in settings().plex).toBe(false);
  });
});

describe('create', () => {
  it('captures own settings, fills slots and manages member fields in one save', async () => {
    const own = cfg(1).visibilityConfig;
    const seen: { occupants: (string | null)[]; vis: unknown }[] = [];
    settings().save.mockImplementation(() => {
      const g = settings().plex.rotationGroups?.[0];
      seen.push({
        occupants: g ? g.state.slots.map((s) => s.occupant) : [],
        vis: JSON.stringify(
          settings().plex.preExistingCollectionConfigs.map(
            (c) => c.visibilityConfig
          )
        ),
      });
    });
    await service.createGroup(input());
    expect(settings().save).toHaveBeenCalledTimes(1);
    expect(seen[0].occupants).toEqual([
      'preExisting:pre-1',
      'preExisting:pre-2',
    ]);
    const g = group();
    expect(g.members.every((m) => m.own)).toBe(true);
    expect(g.members[0].own?.visibilityConfig).toEqual(own);
    expect(cfg(1).visibilityConfig).toEqual(vis(true, true, false));
    expect(cfg(2).visibilityConfig).toEqual(vis(true, true, false));
    expect(cfg(3).visibilityConfig).toEqual(vis(false, false, false));
    expect(cfg(3).sortOrderHome).toBe(0);
  });

  it('rejects invalid input with a readable message', async () => {
    await expect(service.createGroup(input({ name: '' }))).rejects.toThrow(
      /Name/
    );
    await expect(service.createGroup(input({ slotCount: 21 }))).rejects.toThrow(
      /Slots/
    );
    await expect(
      service.createGroup(input({ surfaces: vis(false, false, false) }))
    ).rejects.toThrow(/at least one/);
    await expect(
      service.createGroup(input({ interval: 'weekly' }))
    ).rejects.toThrow(/weekday/);
    await expect(
      service.createGroup(input({ libraryId: 'nope' }))
    ).rejects.toThrow(/library/);
    expect(settings().save).not.toHaveBeenCalled();
    await service.createGroup(input());
    await expect(
      service.createGroup(input({ name: 'group one' }))
    ).rejects.toThrow(/already exists/);
  });
});

describe('pass', () => {
  it('rotates when the period turns, in one save, with one log line', async () => {
    await service.createGroup(input());
    settings().save.mockClear();
    vi.mocked(logger.info).mockClear();
    const next = new Date(NOW.getTime() + 24 * 3600e3);
    const events: string[] = [];
    settings().save.mockImplementation(() => {
      events.push(JSON.stringify(group().state.slots.map((s) => s.occupant)));
      events.push(JSON.stringify(cfg(3).visibilityConfig));
    });
    const res = service.runPass({ now: next, syncRunId: 'run-2' });
    expect(res.rotated).toEqual([group().id]);
    expect(settings().save).toHaveBeenCalledTimes(1);
    expect(events[0]).toContain('preExisting:pre-3');
    expect(events[1]).toBe(JSON.stringify(vis(true, true, false)));
    expect(vi.mocked(logger.info)).toHaveBeenCalledTimes(1);
    expect((vi.mocked(logger.info).mock.calls[0] as unknown[])[1]).toEqual({
      label: 'Rotation',
    });
    expect(cfg(1).visibilityConfig).toEqual(vis(false, false, false));
  });

  it('a second pass in the same period changes nothing, saves nothing, logs nothing', async () => {
    await service.createGroup(input());
    service.runPass({ now: NOW });
    const before = snapshot();
    settings().save.mockClear();
    vi.mocked(logger.info).mockClear();
    const res = service.runPass({ now: new Date(NOW.getTime() + 3600e3) });
    expect(res.saved).toBe(false);
    expect(snapshot()).toBe(before);
    expect(settings().save).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('a throw before the commit leaves settings unchanged', async () => {
    await service.createGroup(input());
    const before = snapshot();
    settings().save.mockClear();
    state.planFails = true;
    expect(() =>
      service.runPass({
        now: new Date(NOW.getTime() + 48 * 3600e3),
        syncRunId: 'x',
      })
    ).toThrow('planner failed');
    expect(snapshot()).toBe(before);
    expect(settings().save).not.toHaveBeenCalled();
  });

  it('adopts a dragged position into the slot', async () => {
    await service.createGroup(input());
    const slotId = group().state.slots[0].id;
    (cfg(1) as { sortOrderHome: number }).sortOrderHome = 9;
    service.runPass({ now: NOW });
    expect(
      group().state.slots.find((s) => s.id === slotId)?.sortOrderHome
    ).toBe(9);
    const res = service.runPass({
      now: new Date(NOW.getTime() + 24 * 3600e3),
      syncRunId: 'r',
    });
    expect(res.rotated.length).toBe(1);
    expect(cfg(3).sortOrderHome).toBe(9);
  });

  it('settlePositions reorders each library and re-adopts positions', async () => {
    await service.createGroup(input());
    autoReorderLibrary.mockImplementationOnce(async () => {
      (cfg(1) as { sortOrderHome: number }).sortOrderHome = 1;
      (cfg(2) as { sortOrderHome: number }).sortOrderHome = 2;
    });
    await service.settlePositions();
    expect(autoReorderLibrary).toHaveBeenCalledWith('lib-1', 'home');
    expect(group().state.slots.map((s) => s.sortOrderHome)).toEqual([1, 2]);
  });

  it('markApplied sets appliedSeq to seq', async () => {
    await service.createGroup(input());
    expect(group().state.appliedSeq).toBe(0);
    service.markApplied();
    expect(group().state.appliedSeq).toBe(group().state.seq);
  });
});

describe('reassert and non-members', () => {
  it('puts managed fields back after a stale full-copy write', async () => {
    await service.createGroup(input());
    cfg(3).visibilityConfig = vis(true, true, true);
    service.reassertManagedFields();
    expect(cfg(3).visibilityConfig).toEqual(vis(false, false, false));
  });

  it('adopts a dragged occupant position instead of reasserting it', async () => {
    await service.createGroup(input());
    (cfg(1) as { sortOrderHome: number }).sortOrderHome = 7;
    service.reassertManagedFields();
    expect(cfg(1).sortOrderHome).toBe(7);
    expect(group().state.slots[0].sortOrderHome).toBe(7);
  });

  it('saving a non-member with groups present leaves it byte-identical', async () => {
    await service.createGroup(
      input({
        members: [1, 2, 3].map((n) => ({
          kind: 'preExisting' as const,
          configId: `pre-${n}`,
        })),
      })
    );
    const before = JSON.stringify(cfg(5));
    cfg(5).name = 'Renamed';
    const renamed = JSON.stringify(cfg(5));
    settings().save.mockClear();
    service.reassertManagedFields();
    expect(JSON.stringify(cfg(5))).toBe(renamed);
    expect(before).not.toBe(renamed);
    expect(settings().save).not.toHaveBeenCalled();
  });

  it('export substitution returns the own values and leaves the stored config alone', async () => {
    await service.createGroup(input());
    const stored = JSON.stringify(cfg(3));
    const out = service.withOwnSettings(cfg(3) as never, 'preExisting') as Cfg;
    expect(out).not.toBe(cfg(3));
    expect(cfg(3).visibilityConfig).toEqual(vis(false, false, false));
    expect(out.visibilityConfig).toEqual(vis(true, true, false));
    expect(out.sortOrderHome).toBe(3);
    expect(JSON.stringify(cfg(3))).toBe(stored);
  });
});

describe('restore reads only the stash', () => {
  const scramble = () => {
    for (let n = 1; n <= 6; n++) {
      cfg(n).visibilityConfig = vis(true, false, true);
      cfg(n).sortOrderHome = 42;
    }
  };

  const originals = () => {
    const fresh = makeSettings();
    return fresh.plex.preExistingCollectionConfigs.map((c) =>
      JSON.stringify({
        v: c.visibilityConfig,
        s: c.sortOrderHome,
        r: c.randomizeHomeOrder,
      })
    );
  };
  const current = () =>
    settings().plex.preExistingCollectionConfigs.map((c) =>
      JSON.stringify({
        v: c.visibilityConfig,
        s: c.sortOrderHome,
        r: c.randomizeHomeOrder,
      })
    );

  it('delete writes own back exactly, even with live values scrambled', async () => {
    const expected = originals();
    await service.createGroup(input());
    scramble();
    service.deleteGroup(group().id);
    expect(current()).toEqual(expected);
  });

  it('disable restores every member and deletes the stashes; enable recaptures', async () => {
    const expected = originals();
    await service.createGroup(input());
    const id = group().id;
    scramble();
    await service.updateGroup(id, input({ enabled: false }));
    expect(current()).toEqual(expected);
    expect(group().members.every((m) => m.own === undefined)).toBe(true);
    expect(group().state.slots.every((s) => s.occupant === null)).toBe(true);
    cfg(1).visibilityConfig = vis(false, true, false);
    await service.updateGroup(id, input({ enabled: true }));
    expect(group().members[0].own?.visibilityConfig).toEqual(
      vis(false, true, false)
    );
    expect(group().state.slots.some((s) => s.occupant)).toBe(true);
  });

  it('removing a member restores it from the stash', async () => {
    await service.createGroup(input());
    const own = JSON.stringify(group().members[0].own?.visibilityConfig);
    scramble();
    await service.updateGroup(
      group().id,
      input({ members: input().members.slice(1) })
    );
    expect(JSON.stringify(cfg(1).visibilityConfig)).toBe(own);
    expect(group().members.length).toBe(5);
  });

  it('a missing stash is not guessed: member is left hidden and a warning is produced', async () => {
    await service.createGroup(input());
    delete group().members[0].own;
    cfg(1).visibilityConfig = vis(true, true, true);
    const status = await service.getStatus(group().id);
    expect(status.warnings.map((w) => w.code)).toContain(
      'own_settings_missing'
    );
    service.deleteGroup(group().id);
    expect(cfg(1).visibilityConfig).toEqual(vis(false, false, false));
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('membership and own settings', () => {
  it('patchOwn changes the stash and not the live fields', async () => {
    await service.createGroup(input());
    const live = JSON.stringify(cfg(3));
    const m = service.patchOwn('preExisting', 'pre-3', {
      visibilityConfig: vis(true, false, false),
      randomizeHomeOrder: true,
    });
    expect(m.own?.visibilityConfig).toEqual(vis(true, false, false));
    expect(m.own?.randomizeHomeOrder).toBe(true);
    expect(JSON.stringify(cfg(3))).toBe(live);
    service.deleteGroup(group().id);
    expect(cfg(3).visibilityConfig).toEqual(vis(true, false, false));
  });

  it('patchOwn merges partial visibility and ignores undefined values', async () => {
    await service.createGroup(input());
    const m = service.patchOwn('preExisting', 'pre-1', {
      visibilityConfig: { libraryRecommended: true } as never,
    });
    expect(m.own?.visibilityConfig).toEqual(vis(true, true, true));
    const m2 = service.patchOwn('preExisting', 'pre-1', {
      visibilityConfig: {
        usersHome: undefined,
        serverOwnerHome: false,
      } as never,
    });
    expect(m2.own?.visibilityConfig).toEqual(vis(true, false, true));
  });

  it('reassert after PUT-style writes of own visibility on a waiting member keeps it hidden and the stash intact', async () => {
    await service.createGroup(input());
    const stash = JSON.stringify(group().members[2].own);
    for (const body of [vis(true, true, true), vis(false, true, false)]) {
      cfg(3).visibilityConfig = { ...body };
      service.reassertManagedFields();
      expect(cfg(3).visibilityConfig).toEqual(vis(false, false, false));
      expect(JSON.stringify(group().members[2].own)).toBe(stash);
    }
  });

  it('patchOwn on a non-member throws not found', async () => {
    await service.createGroup(
      input({ members: [{ kind: 'preExisting', configId: 'pre-1' }] })
    );
    expect(() => service.patchOwn('preExisting', 'pre-5', {})).toThrow(
      /Not part/
    );
  });

  it('membership map names showing members and is empty when unused', async () => {
    expect(service.getMembershipMap()).toEqual({});
    await service.createGroup(input());
    const map = service.getMembershipMap();
    expect(map['preExisting:pre-1'].showing).toBe(true);
    expect(map['preExisting:pre-1'].slotIndex).toBe(0);
    expect(map['preExisting:pre-3'].showing).toBe(false);
  });

  it('moveToFront queues a waiting member and rejects a showing one', async () => {
    await service.createGroup(input());
    service.moveToFront(group().id, 'preExisting:pre-5');
    expect(group().state.queue[0]).toBe('preExisting:pre-5');
    expect(() => service.moveToFront(group().id, 'preExisting:pre-1')).toThrow(
      /already showing/
    );
  });
});

describe('rebind', () => {
  it('re-binds a recreated pre-existing collection by title', async () => {
    await service.createGroup(input());
    const old = settings().plex.preExistingCollectionConfigs.splice(2, 1)[0];
    settings().plex.preExistingCollectionConfigs.push(
      pre(30, { name: old.name, collectionRatingKey: 'rk-new' })
    );
    service.runPass({ now: NOW });
    const m = group().members.find((x) => x.name === old.name);
    expect(m?.configId).toBe('pre-30');
    expect(m?.rebound?.previousRatingKey).toBe('rk-3');
    expect(m?.unboundSince).toBeUndefined();
    expect(m?.own).toBeDefined();
    expect(group().state.queue).toContain('preExisting:pre-30');
    expect(group().state.queue).not.toContain('preExisting:pre-3');
  });

  it('two same-title candidates do not bind', async () => {
    await service.createGroup(input());
    const old = settings().plex.preExistingCollectionConfigs.splice(2, 1)[0];
    settings().plex.preExistingCollectionConfigs.push(
      pre(30, { name: old.name }),
      pre(31, { name: old.name })
    );
    service.runPass({ now: NOW });
    const m = group().members.find((x) => x.name === old.name);
    expect(m?.configId).toBe('pre-3');
    expect(m?.unboundSince).toBeDefined();
    const status = await service.getStatus(group().id);
    expect(status.warnings.map((w) => w.code)).toContain('unbound');
  });
});

describe('status and previews', () => {
  it('reports slots, up next, cycle and the next sync', async () => {
    await service.createGroup(input());
    const s = await service.getStatus(group().id);
    expect(s.slots.map((x) => x.index)).toEqual([0, 1]);
    expect(s.slots[0].occupant?.state).toBe('showing');
    expect(s.upNext.map((m) => m.key)).toEqual([
      'preExisting:pre-3',
      'preExisting:pre-4',
    ]);
    expect(s.cycle.total).toBe(6);
    expect(s.memberCount).toBe(6);
    expect(s.nextChange.kind).toBe('boundary');
    expect(s.nextChange.expectedSyncAt).toBeDefined();
    expect(s.members?.length).toBe(6);
    expect(
      s.members?.find((m) => m.key === 'preExisting:pre-3')?.queuePosition
    ).toBe(1);
  });

  it('previewDraft saves nothing and describes who leaves and joins', async () => {
    await service.createGroup(input());
    const before = snapshot();
    settings().save.mockClear();
    const p = await service.previewDraft({
      ...input({ slotCount: 3, members: input().members.slice(0, 5) }),
      id: group().id,
    });
    expect(p.restored.map((m) => m.key)).toEqual(['preExisting:pre-6']);
    expect(p.now.length).toBe(3);
    expect(snapshot()).toBe(before);
    expect(settings().save).not.toHaveBeenCalled();
  });

  it('previewSaved lists upcoming batches without changing anything', async () => {
    await service.createGroup(input());
    const before = snapshot();
    const p = await service.previewSaved(group().id, 3);
    expect(p.steps.length).toBe(3);
    expect(p.steps[0].slots.map((m) => m.key)).toEqual([
      'preExisting:pre-3',
      'preExisting:pre-4',
    ]);
    expect(snapshot()).toBe(before);
  });

  it('rotateNow forces a swap without a sync, and says why when it cannot', async () => {
    await service.createGroup(input());
    expect(service.rotateNow(group().id)).toEqual({ rotated: true });
    expect(group().state.slots[0].occupant).toBe('preExisting:pre-3');
    await service.updateGroup(
      group().id,
      input({ members: input().members.slice(0, 2) })
    );
    expect(service.rotateNow(group().id)).toEqual({
      rotated: false,
      reason: 'pool_not_larger_than_slots',
    });
  });

  it('lists candidates with the reason a collection cannot join', async () => {
    await service.createGroup(
      input({ members: [{ kind: 'preExisting', configId: 'pre-1' }] })
    );
    const list = await service.listCandidates('lib-1');
    const one = list.find((c) => c.configId === 'pre-1');
    expect(one?.selectable).toBe(false);
    expect(one?.reason).toBe('other_group');
    expect(list.find((c) => c.configId === 'pre-2')?.selectable).toBe(true);
  });

  it('deleting a collection drops its member and repairs the slot', async () => {
    await service.createGroup(input());
    settings().plex.preExistingCollectionConfigs.splice(0, 1);
    service.onCollectionDeleted('pre-1');
    expect(group().members.length).toBe(6);
  });
});

describe('collection kind', () => {
  it('onCollectionDeleted removes an Agregarr member and fills its slot', async () => {
    const c = (n: number): Cfg => ({
      id: `cfg-${n}`,
      name: `List ${n}`,
      type: 'tmdb',
      subtype: 'popular',
      template: 't',
      libraryId: 'lib-1',
      libraryName: 'Library One',
      collectionRatingKey: `ck-${n}`,
      sortOrderHome: n,
      visibilityConfig: vis(true, true, false),
      isActive: true,
      maxItems: 10,
    });
    settings().plex.collectionConfigs = [c(1), c(2), c(3)];
    await service.createGroup(
      input({
        slotCount: 1,
        members: [1, 2, 3].map((n) => ({
          kind: 'collection' as const,
          configId: `cfg-${n}`,
        })),
      })
    );
    expect(group().state.slots[0].occupant).toBe('collection:cfg-1');
    settings().plex.collectionConfigs.splice(0, 1);
    service.onCollectionDeleted('cfg-1');
    expect(group().members.map((m) => m.key)).toEqual([
      'collection:cfg-2',
      'collection:cfg-3',
    ]);
    expect(group().state.slots[0].occupant).toBe('collection:cfg-2');
  });
});

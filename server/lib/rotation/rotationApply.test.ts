import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sync: { running: false, pending: false },
  calls: [] as string[],
  hubGate: undefined as Promise<void> | undefined,
  hubFails: false,
  markApplied: vi.fn(),
  enabled: [] as unknown[],
  hubs: [] as unknown[],
  hubReadFails: false,
  captureSeqs: vi.fn((): Record<string, number> => ({ g1: 4 })),
}));

vi.mock('@server/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({ plex: { ip: 'host' } }),
}));
vi.mock('@server/lib/collectionsSync', () => ({ default: m.sync }));
vi.mock('@server/lib/collections/core/CollectionUtilities', () => ({
  getAdminUser: async () => ({ plexToken: 'token' }),
}));
vi.mock('@server/api/plexapi', () => ({
  default: class {
    async getHubManagement() {
      if (m.hubReadFails) throw new Error('read failed');
      return { MediaContainer: { Hub: m.hubs } };
    }
  },
}));
vi.mock('@server/lib/collections/plex/HubSyncService', () => ({
  HubSyncService: class {
    async syncHubVisibility() {
      m.calls.push('hub');
      if (m.hubFails) throw new Error('plex down');
      await m.hubGate;
    }
    async syncUnifiedOrdering() {
      m.calls.push('ordering');
    }
  },
}));
vi.mock('./RotationGroupService', () => ({
  rotationGroupService: {
    captureSeqs: m.captureSeqs,
    enabledGroups: () => m.enabled,
    settlePositions: async (libs: string[]) => {
      m.calls.push(`settle:${libs.join(',')}`);
    },
    markApplied: (seqs: unknown) => {
      m.calls.push('mark');
      m.markApplied(seqs);
    },
  },
}));

import logger from '@server/logger';
import { groupAppliedInPlex, rotationApply } from './rotationApply';
import type { RotationGroup } from './types';

const idle = () =>
  vi.waitFor(() => expect(rotationApply.status.running).toBe(false));

beforeEach(async () => {
  await idle();
  m.sync.running = false;
  m.sync.pending = false;
  m.calls.length = 0;
  m.hubGate = undefined;
  m.hubFails = false;
  m.enabled = [];
  m.hubs = [];
  m.hubReadFails = false;
  m.markApplied.mockClear();
  vi.mocked(logger.error).mockClear();
});

describe('rotationApply', () => {
  it('kick returns immediately and does the work in the background', async () => {
    rotationApply.kick();
    expect(rotationApply.status.running).toBe(true);
    expect(m.calls).toEqual([]);
    await idle();
    expect(m.calls).toEqual(['settle:', 'hub', 'ordering', 'mark']);
  });

  it('settles the kicked library before applying, and running is true synchronously', async () => {
    rotationApply.kick('lib-9');
    expect(rotationApply.status.running).toBe(true);
    await idle();
    expect(m.calls[0]).toBe('settle:lib-9');
    expect(m.calls.indexOf('hub')).toBeGreaterThan(0);
  });

  it('marks only the seqs captured before the Plex pass', async () => {
    rotationApply.kick();
    await idle();
    expect(m.markApplied).toHaveBeenCalledWith({ g1: 4 });
  });

  it.each([
    ['running', { running: true, pending: false }],
    ['pending', { running: false, pending: true }],
  ])('skips while a collections sync is %s', async (_n, state) => {
    Object.assign(m.sync, state);
    rotationApply.kick();
    await idle();
    expect(m.calls).toEqual([]);
    expect(m.markApplied).not.toHaveBeenCalled();
  });

  it('a second kick during a run causes exactly one rerun', async () => {
    let release!: () => void;
    m.hubGate = new Promise<void>((r) => (release = r));
    rotationApply.kick();
    await vi.waitFor(() => expect(m.calls).toContain('hub'));
    rotationApply.kick();
    rotationApply.kick();
    m.hubGate = undefined;
    release();
    await idle();
    expect(m.calls.filter((c) => c === 'hub').length).toBe(2);
    expect(m.calls.filter((c) => c === 'mark').length).toBe(2);
  });

  it('logs an error, does not throw, and status returns to not running', async () => {
    m.hubFails = true;
    expect(() => rotationApply.kick()).not.toThrow();
    await idle();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(m.markApplied).not.toHaveBeenCalled();
  });
});

const surfaces = {
  usersHome: true,
  serverOwnerHome: false,
  libraryRecommended: true,
};
const member = (n: number, extra: object = {}) => ({
  key: `preExisting:m${n}`,
  kind: 'preExisting',
  configId: `m${n}`,
  name: `M${n}`,
  ratingKey: `rk${n}`,
  addedAt: '',
  ...extra,
});
const grp = (over: object = {}): RotationGroup =>
  ({
    id: 'g1',
    libraryId: 'L1',
    enabled: true,
    surfaces,
    members: [member(1), member(2), member(3, { unboundSince: 'x' })],
    state: {
      seq: 4,
      appliedSeq: 0,
      periodKey: null,
      slots: [{ id: 's1', occupant: 'preExisting:m1', sortOrderHome: 1 }],
      queue: [],
      shownThisCycle: [],
      cycle: 1,
    },
    ...over,
  } as unknown as RotationGroup);
const row = (n: number, f: object) => ({
  identifier: `custom.collection.L1.rk${n}`,
  ...f,
});
const ON = {
  promotedToSharedHome: true,
  promotedToOwnHome: false,
  promotedToRecommended: true,
};

describe('groupAppliedInPlex', () => {
  it('is true when the occupant has exactly the surfaces and the waiting member has none', () => {
    expect(groupAppliedInPlex(grp(), [row(1, ON), row(2, {})])).toBe(true);
  });
  it('is true when a waiting member has no hub row at all', () => {
    expect(groupAppliedInPlex(grp(), [row(1, ON)])).toBe(true);
  });
  it('is false when the occupant row is missing or has different flags', () => {
    expect(groupAppliedInPlex(grp(), [])).toBe(false);
    expect(
      groupAppliedInPlex(grp(), [row(1, { ...ON, promotedToOwnHome: true })])
    ).toBe(false);
    expect(groupAppliedInPlex(grp(), [row(1, {})])).toBe(false);
  });
  it('is false when a waiting member is still on a surface', () => {
    expect(
      groupAppliedInPlex(grp(), [
        row(1, ON),
        row(2, { promotedToRecommended: true }),
      ])
    ).toBe(false);
  });
  it('ignores unbound members and members without a rating key', () => {
    expect(groupAppliedInPlex(grp(), [row(1, ON), row(3, ON)])).toBe(true);
  });
});

describe('markVerified through kick', () => {
  it('marks a group only when Plex matches, otherwise leaves it unapplied', async () => {
    m.enabled = [grp()];
    m.captureSeqs.mockReturnValueOnce({ g1: 4, other: 2 });
    m.hubs = [row(1, {})];
    rotationApply.kick();
    await idle();
    expect(m.markApplied).toHaveBeenCalledWith({ other: 2 });

    m.markApplied.mockClear();
    m.captureSeqs.mockReturnValueOnce({ g1: 4 });
    m.hubs = [row(1, ON)];
    rotationApply.kick();
    await idle();
    expect(m.markApplied).toHaveBeenCalledWith({ g1: 4 });
  });

  it('does not mark when the hub management read fails', async () => {
    m.enabled = [grp()];
    m.captureSeqs.mockReturnValueOnce({ g1: 4 });
    m.hubReadFails = true;
    rotationApply.kick();
    await idle();
    expect(m.markApplied).toHaveBeenCalledWith({});
  });

  it('does not mark a group whose seq moved after the capture', async () => {
    m.enabled = [grp()];
    m.captureSeqs.mockReturnValueOnce({ g1: 3 });
    m.hubs = [row(1, ON)];
    rotationApply.kick();
    await idle();
    expect(m.markApplied).toHaveBeenCalledWith({});
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sync: { running: false, pending: false },
  calls: [] as string[],
  hubGate: undefined as Promise<void> | undefined,
  hubFails: false,
  markApplied: vi.fn(),
  captureSeqs: vi.fn(() => ({ g1: 4 })),
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
vi.mock('@server/api/plexapi', () => ({ default: class {} }));
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
    markApplied: (seqs: unknown) => {
      m.calls.push('mark');
      m.markApplied(seqs);
    },
  },
}));

import logger from '@server/logger';
import { rotationApply } from './rotationApply';

const idle = () =>
  vi.waitFor(() => expect(rotationApply.status.running).toBe(false));

beforeEach(async () => {
  await idle();
  m.sync.running = false;
  m.sync.pending = false;
  m.calls.length = 0;
  m.hubGate = undefined;
  m.hubFails = false;
  m.markApplied.mockClear();
  vi.mocked(logger.error).mockClear();
});

describe('rotationApply', () => {
  it('kick returns immediately and does the work in the background', async () => {
    rotationApply.kick();
    expect(rotationApply.status.running).toBe(true);
    expect(m.calls).toEqual([]);
    await idle();
    expect(m.calls).toEqual(['hub', 'ordering', 'mark']);
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

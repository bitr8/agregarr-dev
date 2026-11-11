import { isOnRootFilesystem } from '@server/utils/mountedVolume';
import { describe, expect, it, vi } from 'vitest';

const CONTAINER = `552 110 0:42 /layers/abc / rw,noatime - btrfs /dev/sdX1 rw,ssd,subvol=/layers/abc
554 552 0:309 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
555 552 0:310 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755
557 552 0:312 / /sys ro,nosuid,nodev,noexec,relatime - sysfs sysfs ro
561 552 0:47 /movies /movies rw,nosuid,nodev,noatime - fuse.shfs shfs rw,user_id=0,group_id=0
562 552 0:47 /tv /tv rw,nosuid,nodev,noatime - fuse.shfs shfs rw,user_id=0,group_id=0
563 552 0:47 /appdata/app /app/config rw,nosuid,nodev,noatime - fuse.shfs shfs rw,user_id=0,group_id=0
564 552 0:42 /containers/c1/hosts /etc/hosts rw,noatime - btrfs /dev/sdX1 rw,subvol=/
565 552 0:50 /My\\040Media /spaced\\040dir rw - fuse.shfs shfs rw
`;

describe('isOnRootFilesystem', () => {
  it('is false for bind-mounted roots and their subfolders', () => {
    expect(isOnRootFilesystem(CONTAINER, '/movies')).toBe(false);
    expect(isOnRootFilesystem(CONTAINER, '/tv/Shows/Placeholders')).toBe(false);
    expect(isOnRootFilesystem(CONTAINER, '/spaced dir/x')).toBe(false);
  });

  it('is true for paths that only exist in the container layer', () => {
    expect(isOnRootFilesystem(CONTAINER, '/data-not-mounted')).toBe(true);
    expect(isOnRootFilesystem(CONTAINER, '/mnt/movies')).toBe(true);
  });

  it('does not treat a sibling with a shared name prefix as mounted', () => {
    expect(isOnRootFilesystem(CONTAINER, '/movies-extra')).toBe(true);
  });

  it('is false when there is no mountinfo to match', () => {
    expect(isOnRootFilesystem('', '/movies')).toBe(false);
  });
});

describe('isOnContainerRootFs', () => {
  const load = async (opts: {
    container: boolean;
    podman?: boolean;
    mountinfo?: string;
    existing?: string[];
    statHook?: (p: string) => Promise<unknown> | undefined;
  }) => {
    vi.resetModules();
    const existing = new Set(['/', ...(opts.existing ?? [])]);
    vi.doMock('fs/promises', () => {
      const mocked = {
        stat: async (p: string) => {
          const hooked = opts.statHook?.(p);
          if (hooked) return hooked;
          const marker =
            p === '/.dockerenv'
              ? opts.container
              : p === '/run/.containerenv'
              ? !!opts.podman
              : existing.has(p);
          if (marker) return {};
          throw new Error('ENOENT');
        },
        realpath: async (p: string) => {
          if (existing.has(p)) return p;
          throw new Error('ENOENT');
        },
        readFile: async () => {
          if (opts.mountinfo === undefined) throw new Error('ENOENT');
          return opts.mountinfo;
        },
      };
      return { ...mocked, default: mocked };
    });
    return (await import('@server/utils/mountedVolume')).isOnContainerRootFs;
  };

  it('warns for an unmounted path inside a container', async () => {
    const fn = await load({
      container: true,
      mountinfo: CONTAINER,
      existing: ['/data-not-mounted'],
    });
    expect(await fn('/data-not-mounted')).toBe(true);
  });

  it('stays quiet on bare metal where / is a real disk', async () => {
    const fn = await load({
      container: false,
      mountinfo: CONTAINER,
      existing: ['/data-not-mounted'],
    });
    expect(await fn('/data-not-mounted')).toBe(false);
  });

  it('detects a Podman container via /run/.containerenv', async () => {
    const fn = await load({
      container: false,
      podman: true,
      mountinfo: CONTAINER,
      existing: ['/data-not-mounted'],
    });
    expect(await fn('/data-not-mounted')).toBe(true);
  });

  it('stays quiet when mountinfo is unreadable', async () => {
    const fn = await load({
      container: true,
      existing: ['/data-not-mounted'],
    });
    expect(await fn('/data-not-mounted')).toBe(false);
  });

  it('missing root under an existing mounted folder is not flagged', async () => {
    const fn = await load({
      container: true,
      mountinfo: CONTAINER,
      existing: ['/movies'],
    });
    expect(await fn('/movies/new/deeper')).toBe(false);
  });

  it('missing root whose only existing ancestor is / is flagged', async () => {
    const fn = await load({ container: true, mountinfo: CONTAINER });
    expect(await fn('/nope/new')).toBe(true);
  });

  describe('in-flight probe sharing', () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));

    it('keeps one stat in flight per target', async () => {
      const target = '/hang/root';
      let release: () => void = () => undefined;
      const pending = new Promise<unknown>((r) => {
        release = () => r({});
      });
      const statHook = vi.fn((p: string) =>
        p === target ? pending : undefined
      );
      const fn = await load({
        container: true,
        mountinfo: CONTAINER,
        statHook,
      });
      const a = fn(target);
      const b = fn(target);
      const c = fn(target);
      await flush();
      expect(statHook.mock.calls.filter(([p]) => p === target)).toHaveLength(1);
      expect(b).toBe(a);
      expect(c).toBe(a);
      release();
      await a;
    });

    it('probes fresh once the previous probe settled', async () => {
      const target = '/movies';
      const statHook = vi.fn<(p: string) => undefined>(() => undefined);
      const fn = await load({
        container: true,
        mountinfo: CONTAINER,
        existing: [target],
        statHook,
      });
      await fn(target);
      const before = statHook.mock.calls.filter(([p]) => p === target).length;
      expect(before).toBeGreaterThan(0);
      await fn(target);
      const after = statHook.mock.calls.filter(([p]) => p === target).length;
      expect(after).toBe(before * 2);
    });
  });
});

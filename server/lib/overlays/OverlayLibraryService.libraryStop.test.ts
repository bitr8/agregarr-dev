import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/datasource', () => ({
  getRepository: () => ({ findOne: () => Promise.resolve(null) }),
}));

import { overlayLibraryService } from './OverlayLibraryService';

type Internals = {
  processLibraryOverlays: (
    libraryId: string,
    config: unknown,
    checkCancelled?: () => boolean
  ) => Promise<void>;
  cancelledLibraries: Set<string>;
  runningLibraries: Map<string, unknown>;
};
const svc = overlayLibraryService as unknown as Internals;

describe('per-library stop', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    svc.runningLibraries.clear();
    svc.cancelledLibraries.clear();
  });

  it('stops a run started without a scheduled-job checker, and only that library', async () => {
    const seen: Record<string, () => boolean> = {};
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(svc, 'processLibraryOverlays').mockImplementation(
      async (libraryId, _config, checkCancelled) => {
        seen[libraryId] = checkCancelled as () => boolean;
        await gate;
      }
    );

    const a = overlayLibraryService.applyOverlaysToLibrary('lib-a');
    const b = overlayLibraryService.applyOverlaysToLibrary('lib-b');
    await vi.waitFor(() => expect(Object.keys(seen)).toHaveLength(2));

    expect(seen['lib-a']()).toBe(false);
    expect(overlayLibraryService.requestCancellation('lib-a')).toBe(
      'requested'
    );
    expect(seen['lib-a']()).toBe(true);
    expect(seen['lib-b']()).toBe(false);
    expect(overlayLibraryService.requestCancellation('lib-a')).toBe('already');

    release();
    await Promise.all([a, b]);
  });

  it('does not carry a stop request into the next run of the same library', async () => {
    const seen: (() => boolean)[] = [];
    vi.spyOn(svc, 'processLibraryOverlays').mockImplementation(
      async (_libraryId, _config, checkCancelled) => {
        seen.push(checkCancelled as () => boolean);
        if (seen.length === 1) {
          overlayLibraryService.requestCancellation('lib-a');
          (
            svc.runningLibraries.get('lib-a') as { _promise: Promise<void> }
          )._promise.catch(() => undefined);
          throw new Error('boom');
        }
      }
    );

    await expect(
      overlayLibraryService.applyOverlaysToLibrary('lib-a')
    ).rejects.toThrow('boom');
    expect(svc.cancelledLibraries.has('lib-a')).toBe(false);
    expect(overlayLibraryService.requestCancellation('lib-a')).toBe(
      'not_found'
    );

    await overlayLibraryService.applyOverlaysToLibrary('lib-a');
    expect(seen[1]()).toBe(false);
  });
});

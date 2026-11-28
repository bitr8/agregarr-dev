import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runForItem: vi.fn(),
}));

vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('@server/lib/collectionsSync', () => ({
  default: { status: { running: false, pending: false } },
}));
vi.mock('@server/lib/collectionsQuickSync', () => ({
  default: { status: { running: false }, runForItem: mocks.runForItem },
}));
vi.mock('@server/lib/overlayApplication', () => ({
  default: { status: { running: false, pending: false } },
}));
vi.mock('@server/lib/overlays/OverlayLibraryService', () => ({
  overlayLibraryService: {
    getLibraryStatus: () => ({ running: false }),
    getAllRunningLibraries: () => [],
  },
}));

import {
  PosterizarrTriggerJob,
  runCollectionsQuickSyncForItem,
} from './posterizarrTrigger';

const result = {
  libraryId: '1',
  title: 't',
  itemsMatched: 1,
  collectionsUpdated: 1,
  itemsAdded: 1,
  placeholdersDeleted: 1,
};

const makeJob = () =>
  new PosterizarrTriggerJob(
    (i) => runCollectionsQuickSyncForItem(i.ratingKey),
    300_000,
    50,
    'placeholder swap trigger',
    'Placeholder Swap'
  );

const idle = (job: PosterizarrTriggerJob) =>
  vi.waitFor(() => expect(job.busy).toBe(false), { timeout: 5000 });

describe('placeholder swap queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runForItem.mockResolvedValue(result);
  });

  it('runs runForItem once per unique ratingKey and dedupes repeats', async () => {
    const job = makeJob();
    expect(job.enqueue({ ratingKey: '10' }).queued).toBe(true);
    expect(job.enqueue({ ratingKey: '10' }).deduplicated).toBe(true);
    expect(job.enqueue({ ratingKey: '11' }).queued).toBe(true);
    await idle(job);
    expect(job.enqueue({ ratingKey: '10' }).deduplicated).toBe(true);
    expect(mocks.runForItem.mock.calls.map((c) => c[0])).toEqual(['10', '11']);
  });

  it('retries when runForItem reports already running', async () => {
    mocks.runForItem
      .mockRejectedValueOnce(
        new Error('Collections Quick Sync is already running')
      )
      .mockResolvedValueOnce(result);
    const job = makeJob();
    job.enqueue({ ratingKey: '20' });
    await idle(job);
    expect(mocks.runForItem).toHaveBeenCalledTimes(2);
    expect(job.status.lastResult?.state).toBe('completed');
  });

  it('does not retry other errors', async () => {
    mocks.runForItem.mockRejectedValue(new Error('boom'));
    const job = makeJob();
    job.enqueue({ ratingKey: '30' });
    await idle(job);
    expect(mocks.runForItem).toHaveBeenCalledTimes(1);
    expect(job.status.lastResult?.state).toBe('failed');
  });

  it('is busy while queued so Collections Sync backs off', () => {
    const job = makeJob();
    job.enqueue({ ratingKey: '40' });
    expect(job.busy).toBe(true);
  });
});

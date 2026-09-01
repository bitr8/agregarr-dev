import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), error: vi.fn() },
}));

import {
  PosterizarrTriggerJob,
  type PosterizarrTriggerInput,
} from './posterizarrTrigger';

const resultFor = (input: PosterizarrTriggerInput) => ({
  libraryId: input.mediaType === 'show' ? '2' : '1',
  title: input.title ?? `Item ${input.ratingKey}`,
  itemsMatched: 1,
  collectionsUpdated: 1,
  itemsAdded: 1,
  placeholdersDeleted: 0,
});

const waitForIdle = async (job: PosterizarrTriggerJob): Promise<void> => {
  await vi.waitFor(() => {
    expect(job.status.running).toBe(false);
    expect(job.status.queued).toEqual([]);
  });
};

describe('PosterizarrTriggerJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('processes different items serially and records the last result', async () => {
    const order: string[] = [];
    const processor = vi.fn(async (input: PosterizarrTriggerInput) => {
      order.push(input.ratingKey);
      return resultFor(input);
    });
    const job = new PosterizarrTriggerJob(processor);

    job.enqueue({ ratingKey: '10', title: 'Movie' });
    job.enqueue({ ratingKey: '20', title: 'Show', mediaType: 'show' });
    await waitForIdle(job);

    expect(order).toEqual(['10', '20']);
    expect(job.status.running).toBe(false);
    expect(job.status.queued).toEqual([]);
    expect(job.status.lastResult).toMatchObject({
      ratingKey: '20',
      title: 'Show',
      state: 'completed',
      collectionResult: { libraryId: '2' },
    });
  });

  it('coalesces a duplicate while its rating key is running', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processor = vi.fn(async (input: PosterizarrTriggerInput) => {
      await blocked;
      return resultFor(input);
    });
    const job = new PosterizarrTriggerJob(processor);

    expect(job.enqueue({ ratingKey: '10' }).queued).toBe(true);
    expect(job.enqueue({ ratingKey: '10' })).toEqual({
      queued: false,
      deduplicated: true,
      position: 0,
    });

    release();
    await waitForIdle(job);
    expect(processor).toHaveBeenCalledTimes(1);
  });

  it('queues different episodes of the same show independently', async () => {
    const processed: string[] = [];
    const processor = vi.fn(async (input: PosterizarrTriggerInput) => {
      processed.push(
        `${input.ratingKey}:S${input.seasonNumber}E${input.episodeNumber}`
      );
      return resultFor(input);
    });
    const job = new PosterizarrTriggerJob(processor);

    job.enqueue({
      ratingKey: '20',
      mediaType: 'show',
      seasonNumber: 1,
      episodeNumber: 1,
    });
    job.enqueue({
      ratingKey: '20',
      mediaType: 'show',
      seasonNumber: 1,
      episodeNumber: 2,
    });
    await waitForIdle(job);

    expect(processed).toEqual(['20:S1E1', '20:S1E2']);
  });

  it('continues with the next item after a failed callback', async () => {
    const processor = vi
      .fn()
      .mockRejectedValueOnce(new Error('Plex unavailable'))
      .mockImplementationOnce(async (input: PosterizarrTriggerInput) =>
        resultFor(input)
      );
    const job = new PosterizarrTriggerJob(processor);

    job.enqueue({ ratingKey: '10' });
    job.enqueue({ ratingKey: '20' });
    await waitForIdle(job);

    expect(processor).toHaveBeenCalledTimes(2);
    expect(job.status.lastResult).toMatchObject({
      ratingKey: '20',
      state: 'completed',
    });
  });
});

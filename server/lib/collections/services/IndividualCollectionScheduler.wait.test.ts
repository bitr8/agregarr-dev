import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { IndividualCollectionScheduler } from './IndividualCollectionScheduler';

const queues = (
  IndividualCollectionScheduler as unknown as {
    libraryQueues: Map<string, { running: boolean; queue: unknown[] }>;
  }
).libraryQueues;

afterEach(() => {
  queues.clear();
  vi.useRealTimers();
});

it('returns true straight away when nothing is queued', async () => {
  await expect(
    IndividualCollectionScheduler.waitForIndividualSyncsToComplete()
  ).resolves.toBe(true);
});

it('gives up when asked to stop', async () => {
  queues.set('1', { running: true, queue: [] });
  await expect(
    IndividualCollectionScheduler.waitForIndividualSyncsToComplete(() => true)
  ).resolves.toBe(false);
});

it('gives up at the deadline', async () => {
  vi.useFakeTimers();
  queues.set('1', { running: true, queue: [] });
  const done = IndividualCollectionScheduler.waitForIndividualSyncsToComplete(
    () => false,
    5_000
  );
  await vi.advanceTimersByTimeAsync(6_000);
  await expect(done).resolves.toBe(false);
});

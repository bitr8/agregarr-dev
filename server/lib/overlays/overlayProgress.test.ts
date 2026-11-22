import { describe, expect, it } from 'vitest';
import {
  cloneOverlayTargetProgress,
  createOverlayTargetProgress,
  recordOverlayTargetOutcome,
  retainOverlayItemOutcome,
} from './overlayProgress';

describe('overlay target progress', () => {
  it('tracks each artwork target independently', () => {
    const progress = createOverlayTargetProgress();
    progress.main.totalItems = 2;
    progress.episode.totalItems = 100;

    recordOverlayTargetOutcome(progress, 'main', 'success');
    recordOverlayTargetOutcome(progress, 'episode', 'skipped');
    recordOverlayTargetOutcome(progress, 'episode', 'error');
    recordOverlayTargetOutcome(progress, 'episode', 'filtered');

    expect(progress.main).toMatchObject({
      totalItems: 2,
      currentItem: 1,
      successCount: 1,
    });
    expect(progress.episode).toEqual({
      totalItems: 100,
      currentItem: 3,
      successCount: 0,
      errorCount: 1,
      skippedCount: 1,
      filteredCount: 1,
    });
  });

  it('returns a snapshot that cannot mutate the live counters', () => {
    const progress = createOverlayTargetProgress();
    const snapshot = cloneOverlayTargetProgress(progress);

    snapshot.episode.totalItems = 50;

    expect(progress.episode.totalItems).toBe(0);
  });
});

describe('retainOverlayItemOutcome', () => {
  const run = (outcomes: string[], max: number) => {
    const items: { id: number; outcome: string }[] = [];
    const evicted: number[] = [];
    outcomes.forEach((outcome, id) => {
      const removed = retainOverlayItemOutcome(items, { id, outcome }, max);
      if (removed) evicted.push(removed.id);
    });
    return { kept: items.map((item) => item.id), evicted };
  };

  it('keeps every item under the cap', () => {
    expect(run(['error', 'skipped', 'success'], 3)).toEqual({
      kept: [0, 1, 2],
      evicted: [],
    });
  });

  it('keeps early errors when later unchanged items fill the cap', () => {
    const outcomes = [
      'error',
      'skipped',
      'error',
      ...Array(10).fill('skipped'),
    ];
    const { kept, evicted } = run(outcomes, 5);

    expect(kept).toEqual([0, 2, 10, 11, 12]);
    expect(evicted).toEqual([1, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('drops the oldest error once only errors remain', () => {
    expect(run(['error', 'error', 'error', 'error'], 3)).toEqual({
      kept: [1, 2, 3],
      evicted: [0],
    });
  });
});

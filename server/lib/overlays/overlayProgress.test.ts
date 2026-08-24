import { describe, expect, it } from 'vitest';
import {
  cloneOverlayTargetProgress,
  createOverlayTargetProgress,
  recordOverlayTargetOutcome,
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

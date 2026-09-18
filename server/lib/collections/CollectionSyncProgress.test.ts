import { CollectionSyncProgress } from './CollectionSyncProgress';

import { describe, expect, it } from 'vitest';

describe('CollectionSyncProgress outcomes', () => {
  it('keeps complete searchable outcomes while limiting the recent summary', () => {
    const progress = new CollectionSyncProgress();
    progress.startSync(12);

    for (let index = 0; index < 12; index++) {
      progress.startCollection(
        `config-${index}`,
        `Collection ${index}`,
        'trakt'
      );
      progress.completeCollection('success', index === 11 ? 2 : 0, 1);
    }

    expect(progress.getStatus()?.recentOutcomes).toHaveLength(10);
    expect(progress.getOutcomes('success')).toHaveLength(12);
    expect(progress.getOutcomes('created')).toMatchObject([
      {
        configId: 'config-11',
        created: 2,
      },
    ]);
    expect(progress.getOutcomes()[0].processedAt).toEqual(expect.any(Number));
  });

  it('preserves outcome details after the run completes', () => {
    const progress = new CollectionSyncProgress();
    progress.startSync(1);
    progress.startCollection('config-error', 'Broken Collection', 'tmdb');
    progress.completeCollection('error', 0, 0, 'Plex unavailable');
    progress.complete();

    expect(progress.getOutcomes('error')).toMatchObject([
      {
        configId: 'config-error',
        errorMessage: 'Plex unavailable',
      },
    ]);
  });
});

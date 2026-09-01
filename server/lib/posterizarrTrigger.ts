import type { ItemQuickSyncResult } from '@server/lib/collectionsQuickSync';
import logger from '@server/logger';

export interface PosterizarrTriggerInput {
  ratingKey: string;
  title?: string;
  mediaType?: 'movie' | 'show';
  seasonNumber?: number;
  episodeNumber?: number;
}

export interface PosterizarrTriggerResult {
  ratingKey: string;
  title?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  state: 'completed' | 'failed';
  startedAt: string;
  completedAt: string;
  collectionResult?: ItemQuickSyncResult;
  error?: string;
}

type TriggerProcessor = (
  input: PosterizarrTriggerInput
) => Promise<ItemQuickSyncResult>;

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function waitForConflictingJobs(
  libraryId?: string,
  timeoutMs = 15 * 60 * 1000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const collectionsSync = (await import('@server/lib/collectionsSync'))
      .default;
    const collectionsQuickSync = (
      await import('@server/lib/collectionsQuickSync')
    ).default;
    const overlayApplication = (await import('@server/lib/overlayApplication'))
      .default;
    const { overlayLibraryService } = await import(
      '@server/lib/overlays/OverlayLibraryService'
    );

    const libraryBusy = libraryId
      ? overlayLibraryService.getLibraryStatus(libraryId).running
      : overlayLibraryService.getAllRunningLibraries().length > 0;
    const busy =
      collectionsSync.status.running ||
      collectionsSync.status.pending ||
      collectionsQuickSync.status.running ||
      overlayApplication.status.running ||
      overlayApplication.status.pending ||
      libraryBusy;

    if (!busy) return;
    await wait(1000);
  }

  throw new Error('Timed out waiting for another collection/overlay job');
}

async function processTriggeredItem(
  input: PosterizarrTriggerInput
): Promise<ItemQuickSyncResult> {
  // Collection membership is updated first. Overlay templates that contain a
  // collection condition will then see the new membership during this same job.
  let collectionResult: ItemQuickSyncResult | undefined;
  let lastBusyError: Error | undefined;

  for (let attempt = 1; attempt <= 5; attempt++) {
    await waitForConflictingJobs();
    const collectionsQuickSync = (
      await import('@server/lib/collectionsQuickSync')
    ).default;

    try {
      collectionResult = await collectionsQuickSync.runForItem(input.ratingKey);
      break;
    } catch (error) {
      const candidate =
        error instanceof Error ? error : new Error(String(error));
      if (!candidate.message.toLowerCase().includes('already running')) {
        throw candidate;
      }
      lastBusyError = candidate;
      await wait(1000);
    }
  }

  if (!collectionResult) {
    throw (
      lastBusyError ?? new Error('Could not start targeted collection sync')
    );
  }

  await waitForConflictingJobs(collectionResult.libraryId);
  const { overlayLibraryService } = await import(
    '@server/lib/overlays/OverlayLibraryService'
  );
  await overlayLibraryService.applyPosterizarrTriggeredOverlays(
    input,
    collectionResult.libraryId
  );

  return collectionResult;
}

/**
 * Small keyed queue for Posterizarr callbacks.
 *
 * Arr applications can emit duplicate events, so a rating key that is queued,
 * running, or just completed is coalesced. Different items remain ordered to
 * avoid concurrent writes through the overlay service's shared caches.
 */
export class PosterizarrTriggerJob {
  private queue: PosterizarrTriggerInput[] = [];
  private queuedKeys = new Set<string>();
  private current: PosterizarrTriggerInput | null = null;
  private drainPromise: Promise<void> | null = null;
  private recentlyCompleted = new Map<string, number>();
  private lastResult: PosterizarrTriggerResult | null = null;

  constructor(
    private readonly processor: TriggerProcessor = processTriggeredItem,
    private readonly dedupeWindowMs = 60_000
  ) {}

  private fingerprint(input: PosterizarrTriggerInput): string {
    return [
      input.ratingKey,
      input.seasonNumber ?? '-',
      input.episodeNumber ?? '-',
    ].join(':');
  }

  public get status() {
    this.pruneCompleted();
    return {
      running: this.current !== null,
      current: this.current,
      queued: [...this.queue],
      lastResult: this.lastResult,
    };
  }

  public enqueue(input: PosterizarrTriggerInput): {
    queued: boolean;
    deduplicated: boolean;
    position: number;
  } {
    this.pruneCompleted();
    const fingerprint = this.fingerprint(input);
    const duplicate =
      (this.current && this.fingerprint(this.current) === fingerprint) ||
      this.queuedKeys.has(fingerprint) ||
      this.recentlyCompleted.has(fingerprint);

    if (duplicate) {
      return { queued: false, deduplicated: true, position: 0 };
    }

    this.queue.push(input);
    this.queuedKeys.add(fingerprint);
    const position = this.queue.length;
    if (!this.drainPromise) {
      this.drainPromise = this.drain().finally(() => {
        this.drainPromise = null;
      });
    }

    return { queued: true, deduplicated: false, position };
  }

  private pruneCompleted(): void {
    const cutoff = Date.now() - this.dedupeWindowMs;
    for (const [ratingKey, completedAt] of this.recentlyCompleted) {
      if (completedAt < cutoff) this.recentlyCompleted.delete(ratingKey);
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const input = this.queue.shift();
      if (!input) continue;

      const fingerprint = this.fingerprint(input);
      this.queuedKeys.delete(fingerprint);
      this.current = input;
      const startedAt = new Date().toISOString();

      try {
        logger.info('Starting Posterizarr item trigger', {
          label: 'Posterizarr Trigger',
          ...input,
        });
        const collectionResult = await this.processor(input);
        this.lastResult = {
          ratingKey: input.ratingKey,
          title: input.title ?? collectionResult.title,
          seasonNumber: input.seasonNumber,
          episodeNumber: input.episodeNumber,
          state: 'completed',
          startedAt,
          completedAt: new Date().toISOString(),
          collectionResult,
        };
        logger.info('Posterizarr item trigger completed', {
          label: 'Posterizarr Trigger',
          ...this.lastResult,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.lastResult = {
          ratingKey: input.ratingKey,
          title: input.title,
          seasonNumber: input.seasonNumber,
          episodeNumber: input.episodeNumber,
          state: 'failed',
          startedAt,
          completedAt: new Date().toISOString(),
          error: message,
        };
        logger.error('Posterizarr item trigger failed', {
          label: 'Posterizarr Trigger',
          ...this.lastResult,
        });
      } finally {
        this.recentlyCompleted.set(fingerprint, Date.now());
        this.current = null;
      }
    }
  }
}

const posterizarrTriggerJob = new PosterizarrTriggerJob();
export default posterizarrTriggerJob;

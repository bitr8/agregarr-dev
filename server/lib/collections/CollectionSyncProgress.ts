import type { CollectionSource } from '@server/lib/collections/core/types';
import logger from '@server/logger';

export type SyncPhase =
  | 'setup'
  | 'processing'
  | 'cleanup'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface CollectionOutcome {
  configId: string;
  name: string;
  sourceType: CollectionSource;
  outcome: 'success' | 'error' | 'skipped';
  created: number;
  updated: number;
  errorMessage?: string;
  durationMs: number;
}

interface CollectionSyncProgressData {
  phase: SyncPhase;
  startTime: number;
  completedAt?: number;

  totalCollections: number;
  processedCollections: number;

  currentCollection?: {
    configId: string;
    name: string;
    sourceType: CollectionSource;
    startedAt: number;
  };

  currentDetail?: string;

  successCount: number;
  errorCount: number;
  skippedCount: number;
  createdCount: number;
  updatedCount: number;
  recentOutcomes: CollectionOutcome[];

  _recentCollectionTimes: number[];
}

export interface CollectionSyncStatus {
  phase: SyncPhase;
  phaseLabel: string;
  startTime: number;
  runningFor: number;
  totalCollections: number;
  processedCollections: number;
  progressPercent: number;

  currentCollection?: {
    name: string;
    sourceType: CollectionSource;
    runningFor: number;
  };
  currentDetail?: string;

  successCount: number;
  errorCount: number;
  skippedCount: number;
  createdCount: number;
  updatedCount: number;

  recentOutcomes: CollectionOutcome[];
  estimatedSecondsRemaining: number | null;
  completedAt?: number;
}

const PHASE_LABELS: Record<SyncPhase, string> = {
  setup: 'Preparing',
  processing: 'Syncing Collections',
  cleanup: 'Cleaning Up',
  completed: 'Sync Complete',
  cancelled: 'Sync Cancelled',
  failed: 'Sync Failed',
};

const COMPLETED_TTL_MS = 10_000;
const ETA_MIN_SAMPLES = 3;
const ETA_ROLLING_WINDOW = 20;
const ETA_MAX_SECONDS = 7200;
const MAX_RECENT_OUTCOMES = 10;

function createEmptyData(
  totalCollections: number,
  startTime: number
): CollectionSyncProgressData {
  return {
    phase: 'setup',
    startTime,
    totalCollections,
    processedCollections: 0,
    successCount: 0,
    errorCount: 0,
    skippedCount: 0,
    createdCount: 0,
    updatedCount: 0,
    recentOutcomes: [],
    _recentCollectionTimes: [],
  };
}

function isTerminalPhase(phase: SyncPhase): boolean {
  return phase === 'completed' || phase === 'cancelled' || phase === 'failed';
}

function calculateEta(data: CollectionSyncProgressData): number | null {
  if (isTerminalPhase(data.phase)) return null;

  const times = data._recentCollectionTimes;

  if (times.length < ETA_MIN_SAMPLES || data.totalCollections < ETA_MIN_SAMPLES)
    return null;

  const windowDuration = times[times.length - 1] - times[0];
  if (windowDuration <= 0) return null;

  const avgMsPerCollection = windowDuration / (times.length - 1);
  const remaining = Math.max(
    0,
    data.totalCollections - data.processedCollections
  );
  const etaMs = remaining * avgMsPerCollection;

  return Math.min(ETA_MAX_SECONDS, Math.round(etaMs / 1000));
}

function toStatus(data: CollectionSyncProgressData): CollectionSyncStatus {
  const now = Date.now();
  const endTime = data.completedAt ?? now;
  const runningFor = Math.round((endTime - data.startTime) / 1000);

  const rawPercent =
    data.totalCollections > 0
      ? (data.processedCollections / data.totalCollections) * 100
      : 0;
  const progressPercent = Math.min(100, Math.max(0, Math.round(rawPercent)));

  let currentCollection: CollectionSyncStatus['currentCollection'];
  if (data.currentCollection) {
    currentCollection = {
      name: data.currentCollection.name,
      sourceType: data.currentCollection.sourceType,
      runningFor: Math.round((now - data.currentCollection.startedAt) / 1000),
    };
  }

  return {
    phase: data.phase,
    phaseLabel: PHASE_LABELS[data.phase],
    startTime: data.startTime,
    runningFor,
    totalCollections: data.totalCollections,
    processedCollections: data.processedCollections,
    progressPercent,
    currentCollection,
    currentDetail: data.currentDetail,
    successCount: data.successCount,
    errorCount: data.errorCount,
    skippedCount: data.skippedCount,
    createdCount: data.createdCount,
    updatedCount: data.updatedCount,
    recentOutcomes: data.recentOutcomes.map((o) => ({ ...o })),
    estimatedSecondsRemaining: calculateEta(data),
    completedAt: data.completedAt,
  };
}

class CollectionSyncProgress {
  private current: CollectionSyncProgressData | null = null;
  private lastCompleted: CollectionSyncProgressData | null = null;

  startSync(totalCollections: number): void {
    this.current = createEmptyData(totalCollections, Date.now());
    logger.debug('Collection sync progress started', {
      label: 'Collection Sync Progress',
      totalCollections,
    });
  }

  setPhase(phase: SyncPhase): void {
    if (!this.current) return;
    this.current.phase = phase;
    this.current.currentDetail = undefined;
    this.current.currentCollection = undefined;
    logger.debug(`Collection sync phase: ${PHASE_LABELS[phase]}`, {
      label: 'Collection Sync Progress',
      phase,
    });
  }

  setTotalCollections(total: number): void {
    if (!this.current) return;
    this.current.totalCollections = total;
  }

  setDetail(text: string): void {
    if (!this.current) return;
    this.current.currentDetail = text;
  }

  startCollection(
    configId: string,
    name: string,
    sourceType: CollectionSource
  ): void {
    if (!this.current) return;
    this.current.currentCollection = {
      configId,
      name,
      sourceType,
      startedAt: Date.now(),
    };
    this.current.currentDetail = undefined;
  }

  completeCollection(
    outcome: 'success' | 'error' | 'skipped',
    created: number,
    updated: number,
    errorMessage?: string,
    incrementProcessed = true
  ): void {
    if (!this.current) return;

    if (!this.current.currentCollection) {
      logger.warn('completeCollection called without active collection', {
        label: 'Collection Sync Progress',
        outcome,
      });
      return;
    }

    const now = Date.now();
    const cc = this.current.currentCollection;
    const durationMs = now - cc.startedAt;

    const entry: CollectionOutcome = {
      configId: cc.configId,
      name: cc.name,
      sourceType: cc.sourceType,
      outcome,
      created,
      updated,
      durationMs,
    };
    if (errorMessage) entry.errorMessage = errorMessage;

    this.current.recentOutcomes.unshift(entry);
    if (this.current.recentOutcomes.length > MAX_RECENT_OUTCOMES) {
      this.current.recentOutcomes.length = MAX_RECENT_OUTCOMES;
    }

    switch (outcome) {
      case 'success':
        this.current.successCount++;
        break;
      case 'error':
        this.current.errorCount++;
        break;
      case 'skipped':
        this.current.skippedCount++;
        break;
    }

    this.current.createdCount += created;
    this.current.updatedCount += updated;
    this.current.currentCollection = undefined;

    if (incrementProcessed) {
      this.current.processedCollections++;

      // Rolling window for ETA (per unique collection)
      this.current._recentCollectionTimes.push(now);
      if (this.current._recentCollectionTimes.length > ETA_ROLLING_WINDOW) {
        this.current._recentCollectionTimes.shift();
      }
    }
  }

  complete(): void {
    this.finalize('completed');
  }

  fail(error?: string): void {
    this.finalize('failed');
    if (error) {
      logger.debug(`Collection sync progress failed: ${error}`, {
        label: 'Collection Sync Progress',
      });
    }
  }

  cancel(): void {
    this.finalize('cancelled');
  }

  private finalize(phase: 'completed' | 'cancelled' | 'failed'): void {
    if (!this.current || isTerminalPhase(this.current.phase)) return;
    this.current.phase = phase;
    this.current.completedAt = Date.now();
    this.current.currentCollection = undefined;
    this.current.currentDetail = undefined;

    // Snapshot for lastCompleted before TTL cleanup can clear current
    this.lastCompleted = {
      ...this.current,
      recentOutcomes: [...this.current.recentOutcomes],
      _recentCollectionTimes: [...this.current._recentCollectionTimes],
    };

    logger.debug(`Collection sync progress finalized: ${PHASE_LABELS[phase]}`, {
      label: 'Collection Sync Progress',
      phase,
      success: this.current.successCount,
      errors: this.current.errorCount,
      skipped: this.current.skippedCount,
      durationMs: this.current.completedAt - this.current.startTime,
    });
  }

  getStatus(): CollectionSyncStatus | null {
    this.cleanupExpired();
    if (!this.current) return null;
    return toStatus(this.current);
  }

  getLastCompleted(): CollectionSyncStatus | null {
    if (!this.lastCompleted) return null;
    return toStatus(this.lastCompleted);
  }

  private cleanupExpired(): void {
    if (
      this.current?.completedAt &&
      Date.now() - this.current.completedAt > COMPLETED_TTL_MS
    ) {
      this.current = null;
    }
  }
}

const collectionSyncProgress = new CollectionSyncProgress();
export default collectionSyncProgress;

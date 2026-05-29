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
  sourceType: string;
  outcome: 'success' | 'error' | 'skipped';
  created: number;
  updated: number;
  errorMessage?: string;
  durationMs: number;
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
    sourceType: string;
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

export interface SyncProgressResponse {
  current: CollectionSyncStatus | null;
  lastCompleted: CollectionSyncStatus | null;
}

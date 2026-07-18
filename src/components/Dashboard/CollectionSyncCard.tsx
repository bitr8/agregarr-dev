import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
import type {
  CollectionOutcome,
  SyncPhase,
  SyncProgressResponse,
} from '@app/utils/collections/syncProgressTypes';
import {
  formatDurationMs,
  formatTime,
  formatTimeAgo,
} from '@app/utils/timeFormatters';
import {
  CheckIcon,
  ExclamationTriangleIcon,
  ForwardIcon,
  PlayIcon,
  PlusIcon,
  StopIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import type React from 'react';
import { useState } from 'react';
import { useToasts } from 'react-toast-notifications';
import useSWR from 'swr';

const isActivePhase = (phase: SyncPhase): boolean =>
  phase === 'setup' || phase === 'processing' || phase === 'cleanup';

const getBorderColor = (phase: SyncPhase): string => {
  switch (phase) {
    case 'completed':
      return 'border-green-500';
    case 'cancelled':
      return 'border-amber-500';
    case 'failed':
      return 'border-red-500';
    default:
      return 'border-orange-500';
  }
};

const getProgressBarColor = (phase: SyncPhase): string => {
  switch (phase) {
    case 'completed':
      return 'bg-green-500';
    case 'cancelled':
      return 'bg-amber-500';
    case 'failed':
      return 'bg-red-500';
    default:
      return 'bg-orange-500';
  }
};

const getOutcomeIcon = (outcome: 'success' | 'error' | 'skipped') => {
  switch (outcome) {
    case 'success':
      return <CheckIcon className="h-3.5 w-3.5 text-green-400" />;
    case 'error':
      return <ExclamationTriangleIcon className="h-3.5 w-3.5 text-red-400" />;
    case 'skipped':
      return <ForwardIcon className="h-3.5 w-3.5 text-amber-400" />;
  }
};

const PHASE_STEPS = ['setup', 'processing', 'cleanup'] as const;
const PHASE_STEP_LABELS = ['Preparing', 'Syncing', 'Cleanup'] as const;

const phaseIndex = (phase: SyncPhase): number => {
  switch (phase) {
    case 'setup':
      return 0;
    case 'processing':
      return 1;
    case 'cleanup':
      return 2;
    case 'completed':
    case 'cancelled':
    case 'failed':
      return 3;
  }
};

const PhaseStepper: React.FC<{ phase: SyncPhase }> = ({ phase }) => {
  const activeIdx = phaseIndex(phase);
  const isTerminal = activeIdx >= 3;

  return (
    <div className="flex items-center justify-center gap-0">
      {PHASE_STEPS.map((step, idx) => {
        const isCompleted = idx < activeIdx;
        const isActive = idx === activeIdx && !isTerminal;
        const isFilled = isCompleted || isActive || isTerminal;

        return (
          <div key={step} className="flex items-center">
            <div className="flex flex-col items-center">
              <div
                className={`h-2.5 w-2.5 rounded-full transition-all ${
                  isActive
                    ? 'animate-pulse bg-orange-400'
                    : isFilled
                    ? phase === 'failed'
                      ? 'bg-red-400'
                      : phase === 'cancelled'
                      ? 'bg-amber-400'
                      : 'bg-green-400'
                    : 'bg-gray-600'
                }`}
              />
              <span
                className={`mt-1 text-[10px] ${
                  isActive
                    ? 'font-medium text-orange-400'
                    : isFilled
                    ? 'text-gray-400'
                    : 'text-gray-600'
                }`}
              >
                {PHASE_STEP_LABELS[idx]}
              </span>
            </div>
            {idx < PHASE_STEPS.length - 1 && (
              <div
                className={`mx-2 mb-4 h-px w-12 ${
                  idx < activeIdx ? 'bg-gray-500' : 'bg-gray-700'
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};

const ErrorStatCell: React.FC<{
  errorCount: number;
  recentOutcomes: CollectionOutcome[];
}> = ({ errorCount, recentOutcomes }) => {
  const errorOutcomes = recentOutcomes.filter((o) => o.outcome === 'error');

  const cell = (
    <div
      className={`rounded-md bg-stone-900 p-3 ${
        errorCount > 0 ? 'cursor-help' : ''
      }`}
    >
      <div className="flex items-center gap-2">
        <ExclamationTriangleIcon className="h-4 w-4 text-red-400" />
        <span className="text-xs text-gray-400">Errors</span>
      </div>
      <p className="mt-1 text-lg font-semibold text-red-400">{errorCount}</p>
    </div>
  );

  if (errorCount === 0 || errorOutcomes.length === 0) return cell;

  return (
    <Tooltip
      content={
        <div className="max-w-xs space-y-1.5">
          {errorOutcomes.map((o) => (
            <div key={`${o.configId}-${o.durationMs}`}>
              <span className="font-medium">{o.name}</span>
              {o.errorMessage && (
                <span className="block text-xs text-gray-400">
                  {o.errorMessage}
                </span>
              )}
            </div>
          ))}
          {errorCount > errorOutcomes.length && (
            <span className="block text-xs italic text-gray-500">
              +{errorCount - errorOutcomes.length} older errors
            </span>
          )}
        </div>
      }
    >
      {cell}
    </Tooltip>
  );
};

const CollectionSyncCard: React.FC = () => {
  const [isStopping, setIsStopping] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const { addToast } = useToasts();

  const { data, mutate } = useSWR<SyncProgressResponse>(
    '/api/v1/collections/sync/progress',
    {
      refreshInterval: (latestData) => {
        if (latestData?.current && isActivePhase(latestData.current.phase)) {
          return 1000;
        }
        return 5000;
      },
      revalidateOnFocus: false,
      dedupingInterval: 1000,
    }
  );

  const pending = data?.pending || false;
  const status =
    data?.current ?? (pending ? null : data?.lastCompleted) ?? null;

  const borderColor = status ? getBorderColor(status.phase) : '';
  const progressBarColor = status ? getProgressBarColor(status.phase) : '';
  const eta =
    status?.estimatedSecondsRemaining != null
      ? formatTime(status.estimatedSecondsRemaining)
      : null;

  const handleCancel = async () => {
    if (isStopping) return;
    setIsStopping(true);
    try {
      await axios.post('/api/v1/collections/sync/cancel');
      addToast('Collection sync cancellation requested', {
        appearance: 'success',
        autoDismiss: true,
      });
      await mutate();
    } catch {
      addToast('Failed to cancel collection sync', {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsStopping(false);
    }
  };

  const handleStart = async () => {
    if (isStarting) return;
    setIsStarting(true);
    try {
      await axios.post('/api/v1/collections/sync');
      addToast('Collection sync started', {
        appearance: 'success',
        autoDismiss: true,
      });
      await mutate();
    } catch {
      addToast('Failed to start collection sync', {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsStarting(false);
    }
  };

  if (!status) {
    return (
      <div
        className={`rounded-lg border-2 ${
          pending ? 'border-orange-500' : 'border-stone-700'
        } bg-stone-800 p-6 shadow-sm`}
      >
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-white">
              Collection Sync
            </h3>
            <p className="text-xs text-gray-400">
              {pending ? 'Waiting for overlays...' : 'Idle'}
            </p>
          </div>
          {pending ? (
            <Button
              buttonType="danger"
              buttonSize="sm"
              onClick={handleCancel}
              disabled={isStopping}
              className="flex items-center gap-1.5"
            >
              <StopIcon className="h-4 w-4" />
              {isStopping ? 'Stopping...' : 'Stop'}
            </Button>
          ) : (
            <Button
              buttonType="primary"
              buttonSize="sm"
              onClick={handleStart}
              disabled={isStarting}
              className="flex items-center gap-1.5"
            >
              <PlayIcon className="h-4 w-4" />
              {isStarting ? 'Starting...' : 'Start'}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const active = isActivePhase(status.phase);
  const showDeterminate = status.phase === 'processing';
  const displayedOutcomes = status.recentOutcomes.slice(0, 5);

  return (
    <div
      className={`rounded-lg border-2 ${borderColor} bg-stone-800 p-6 shadow-sm transition-all`}
    >
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">Collection Sync</h3>
          <p className="text-xs text-gray-400">{status.phaseLabel}</p>
        </div>
        {active ? (
          <Button
            buttonType="danger"
            buttonSize="sm"
            onClick={handleCancel}
            disabled={isStopping}
            className="flex items-center gap-1.5"
          >
            <StopIcon className="h-4 w-4" />
            {isStopping ? 'Stopping...' : 'Stop'}
          </Button>
        ) : (
          <Button
            buttonType="primary"
            buttonSize="sm"
            onClick={handleStart}
            disabled={isStarting}
            className="flex items-center gap-1.5"
          >
            <PlayIcon className="h-4 w-4" />
            {isStarting ? 'Starting...' : 'Start'}
          </Button>
        )}
      </div>

      {/* Phase Stepper */}
      <div className="mb-4">
        <PhaseStepper phase={status.phase} />
      </div>

      {/* Progress Bar */}
      <div className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-gray-300">Progress</span>
          {showDeterminate && (
            <span className="text-xs text-gray-400">
              {status.progressPercent}%
            </span>
          )}
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-gray-700">
          {showDeterminate ? (
            <div
              className={`h-full transition-all duration-300 ${progressBarColor}`}
              style={{ width: `${status.progressPercent}%` }}
            />
          ) : active ? (
            <div
              className={`h-full w-1/3 animate-pulse rounded-full ${progressBarColor}`}
            />
          ) : (
            <div
              className={`h-full ${progressBarColor}`}
              style={{ width: '100%' }}
            />
          )}
        </div>
      </div>

      {/* Current Collection Panel */}
      {status.currentCollection && (
        <div className="mb-4 rounded-md bg-stone-900 p-3">
          <p className="text-xs text-gray-500">Syncing</p>
          <p className="truncate text-sm font-medium text-white">
            {status.currentCollection.name}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <span className="rounded bg-stone-700 px-1.5 py-0.5 text-[10px] font-medium text-gray-300">
              {status.currentCollection.sourceType}
            </span>
            <span className="text-xs text-gray-500">
              Collection{' '}
              {Math.min(
                status.processedCollections + 1,
                status.totalCollections
              )}{' '}
              of {status.totalCollections}
            </span>
          </div>
        </div>
      )}

      {/* Stats Grid */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-md bg-stone-900 p-3">
          <div className="flex items-center gap-2">
            <CheckIcon className="h-4 w-4 text-green-400" />
            <span className="text-xs text-gray-400">Synced</span>
          </div>
          <p className="mt-1 text-lg font-semibold text-green-400">
            {status.successCount}
          </p>
        </div>

        <ErrorStatCell
          errorCount={status.errorCount}
          recentOutcomes={status.recentOutcomes}
        />

        <div className="rounded-md bg-stone-900 p-3">
          <div className="flex items-center gap-2">
            <ForwardIcon className="h-4 w-4 text-amber-400" />
            <span className="text-xs text-gray-400">Skipped</span>
          </div>
          <p className="mt-1 text-lg font-semibold text-amber-400">
            {status.skippedCount}
          </p>
        </div>

        <div className="rounded-md bg-stone-900 p-3">
          <div className="flex items-center gap-2">
            <PlusIcon className="h-4 w-4 text-blue-400" />
            <span className="text-xs text-gray-400">Created</span>
          </div>
          <p className="mt-1 text-lg font-semibold text-blue-400">
            {status.createdCount}
          </p>
        </div>
      </div>

      {/* Recent Outcomes */}
      {displayedOutcomes.length > 0 && (
        <div className="mb-4">
          <p className="mb-2 text-xs font-medium text-gray-300">Recent</p>
          <div className="space-y-1">
            {displayedOutcomes.map((outcome) => (
              <div
                key={`${outcome.configId}-${outcome.durationMs}`}
                className="flex items-center gap-2 text-xs"
              >
                {getOutcomeIcon(outcome.outcome)}
                <span className="min-w-0 flex-1 truncate text-gray-300">
                  {outcome.name}
                </span>
                <span className="shrink-0 rounded bg-stone-700 px-1.5 py-0.5 text-[10px] text-gray-400">
                  {outcome.sourceType}
                </span>
                <span className="shrink-0 text-gray-500">
                  {formatDurationMs(outcome.durationMs)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>
          {active
            ? `Processed ${status.processedCollections} / ${status.totalCollections}`
            : `${formatTime(status.runningFor)} elapsed`}
        </span>
        {active && eta ? (
          <span>
            ETA: <span className="text-gray-300">{eta}</span>
          </span>
        ) : !active && status.completedAt ? (
          <span>{formatTimeAgo(status.completedAt)}</span>
        ) : null}
      </div>
    </div>
  );
};

export default CollectionSyncCard;

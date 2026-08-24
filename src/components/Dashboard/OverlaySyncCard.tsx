import Button from '@app/components/Common/Button';
import OverlayLibraryProgressList from '@app/components/Posters/OverlayLibraryProgressList';
import OverlayOutcomeStats from '@app/components/Posters/OverlayOutcomeStats';
import type { OverlayTargetProgressMap } from '@app/components/Posters/OverlayTargetProgress';
import { formatTime, formatTimeAgo } from '@app/utils/timeFormatters';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  PlayIcon,
  StopIcon,
} from '@heroicons/react/24/outline';
import type { OverlayArtworkTarget } from '@server/lib/overlays/overlayTargets';
import axios from 'axios';
import type React from 'react';
import { useMemo, useState } from 'react';
import { useToasts } from 'react-toast-notifications';
import useSWR from 'swr';

interface LibraryStatus {
  libraryId: string;
  running: boolean;
  state: 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
  libraryName: string;
  startTime: number;
  runningFor: number;
  totalItems: number;
  currentItem: number;
  currentTitle: string;
  currentTarget?: OverlayArtworkTarget | null;
  targetProgress?: OverlayTargetProgressMap;
  filteredCount: number;
  successCount: number;
  errorCount: number;
  skippedCount: number;
  progressPercent: number;
  estimatedSecondsRemaining: number | null;
  itemErrors?: { title: string; ratingKey: string; error: string }[];
}

interface JobStatus {
  running: boolean;
  processedLibraries: number;
  totalLibraries: number;
  currentStage: string;
  progress: number;
}

interface RunningLibrariesResponse {
  runningLibraries: LibraryStatus[];
  lastCompleted: LibraryStatus[];
  jobStatus: JobStatus;
  pending: boolean;
}

type OverlayState =
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed';

const getBorderColor = (state: OverlayState): string => {
  switch (state) {
    case 'completed':
      return 'border-green-500';
    case 'cancelled':
    case 'cancelling':
      return 'border-amber-500';
    case 'failed':
      return 'border-red-500';
    default:
      return 'border-orange-500';
  }
};

const getProgressBarColor = (state: OverlayState): string => {
  switch (state) {
    case 'completed':
      return 'bg-green-500';
    case 'cancelled':
    case 'cancelling':
      return 'bg-amber-500';
    case 'failed':
      return 'bg-red-500';
    default:
      return 'bg-orange-500';
  }
};

const getStateLabel = (state: OverlayState): string => {
  switch (state) {
    case 'running':
      return 'In Progress';
    case 'cancelling':
      return 'Stopping...';
    case 'completed':
      return 'Complete';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Failed';
  }
};

const OverlaySyncCard: React.FC = () => {
  const [isStopping, setIsStopping] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [errorsOpen, setErrorsOpen] = useState(false);
  const { addToast } = useToasts();

  const { data, mutate } = useSWR<RunningLibrariesResponse>(
    '/api/v1/overlay-library-configs/status/all',
    {
      refreshInterval: (latestData) => {
        const hasActive =
          latestData?.jobStatus?.running ||
          latestData?.runningLibraries?.some(
            (lib) => lib.state === 'running' || lib.state === 'cancelling'
          );
        return hasActive ? 1000 : 5000;
      },
      revalidateOnFocus: false,
      dedupingInterval: 1000,
    }
  );

  const jobStatus = data?.jobStatus;
  const pending = data?.pending || false;

  const allLibs = useMemo(() => {
    const live = data?.runningLibraries ?? [];
    const completed = data?.lastCompleted ?? [];
    if (pending) return [];
    const liveIds = new Set(live.map((l) => l.libraryId));
    return [...live, ...completed.filter((l) => !liveIds.has(l.libraryId))];
  }, [data?.runningLibraries, data?.lastCompleted, pending]);

  const liveLibs = data?.runningLibraries ?? [];

  const activeLib = liveLibs.find(
    (lib) => lib.state === 'running' || lib.state === 'cancelling'
  );
  const isActive = !!activeLib || !!jobStatus?.running || pending;
  const overallState: OverlayState = pending
    ? 'running'
    : activeLib?.state === 'cancelling'
    ? 'cancelling'
    : activeLib?.state === 'running' || jobStatus?.running
    ? 'running'
    : allLibs.some((l) => l.state === 'failed')
    ? 'failed'
    : allLibs.some((l) => l.state === 'cancelled')
    ? 'cancelled'
    : allLibs.length > 0
    ? 'completed'
    : 'completed';

  const handleStop = async () => {
    if (isStopping) return;
    setIsStopping(true);
    try {
      const stopPromises: Promise<unknown>[] = [
        axios.post('/api/v1/settings/jobs/overlay-application/cancel'),
      ];
      for (const lib of liveLibs) {
        if (lib.state === 'running') {
          stopPromises.push(
            axios
              .post(`/api/v1/overlay-library-configs/${lib.libraryId}/stop`)
              .catch(() => undefined)
          );
        }
      }
      await Promise.all(stopPromises);
      addToast('Overlay job cancelled', {
        appearance: 'success',
        autoDismiss: true,
      });
      await mutate();
    } catch {
      addToast('Failed to stop overlay job', {
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
      await axios.post('/api/v1/settings/jobs/overlay-application/run');
      addToast('Overlay job started', {
        appearance: 'success',
        autoDismiss: true,
      });
      await mutate();
    } catch {
      addToast('Failed to start overlay job', {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsStarting(false);
    }
  };

  if (allLibs.length === 0 && !isActive) {
    const lastLibs = data?.lastCompleted;
    const lastSuccess = lastLibs?.reduce((s, l) => s + l.successCount, 0) ?? 0;
    const lastErrors = lastLibs?.reduce((s, l) => s + l.errorCount, 0) ?? 0;
    const libsWithErrors = lastLibs?.filter(
      (l) => l.itemErrors && l.itemErrors.length > 0
    );
    const lastFinishedAt = lastLibs?.length
      ? Math.max(...lastLibs.map((l) => l.startTime + l.runningFor * 1000))
      : null;

    return (
      <div className="rounded-lg border-2 border-stone-700 bg-stone-800 p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-white">Overlay Sync</h3>
            <p className="text-xs text-gray-400">Idle</p>
          </div>
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
        </div>
        {lastLibs && lastLibs.length > 0 && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-gray-400">
              Last: {lastSuccess} overlaid
              {lastErrors > 0 && (
                <span className="text-red-400">, {lastErrors} errored</span>
              )}
              {lastFinishedAt && (
                <span> &mdash; {formatTimeAgo(lastFinishedAt)}</span>
              )}
            </p>
            {libsWithErrors && libsWithErrors.length > 0 && (
              <div>
                <button
                  onClick={() => setErrorsOpen(!errorsOpen)}
                  className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300"
                >
                  {errorsOpen ? (
                    <ChevronDownIcon className="h-3 w-3" />
                  ) : (
                    <ChevronRightIcon className="h-3 w-3" />
                  )}
                  {lastErrors} error{lastErrors !== 1 && 's'}
                </button>
                {errorsOpen && (
                  <div className="mt-1 space-y-2 pl-4">
                    {libsWithErrors.map((lib) => (
                      <div key={lib.libraryId}>
                        <p className="text-xs font-medium text-gray-300">
                          {lib.libraryName}
                        </p>
                        <div className="mt-0.5 space-y-0.5">
                          {lib.itemErrors?.map((e) => (
                            <p
                              key={e.ratingKey}
                              className="text-xs text-gray-500"
                            >
                              {e.title}{' '}
                              <span className="text-gray-600">
                                &mdash; {e.error}
                              </span>
                            </p>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  const totalSuccess = allLibs.reduce((s, l) => s + l.successCount, 0);
  const totalErrors = allLibs.reduce((s, l) => s + l.errorCount, 0);
  const totalSkipped = allLibs.reduce((s, l) => s + l.skippedCount, 0);
  const totalFiltered = allLibs.reduce((s, l) => s + l.filteredCount, 0);
  const totalItems = allLibs.reduce((s, l) => s + l.totalItems, 0);
  const totalProcessed =
    totalSuccess + totalErrors + totalSkipped + totalFiltered;

  const overallProgress = (() => {
    if (overallState === 'completed') return 100;
    if (jobStatus?.running && jobStatus.totalLibraries > 0) {
      const intraFraction =
        activeLib && activeLib.totalItems > 0
          ? activeLib.currentItem / activeLib.totalItems
          : 0;
      return Math.min(
        99,
        Math.round(
          ((jobStatus.processedLibraries + intraFraction) /
            jobStatus.totalLibraries) *
            100
        )
      );
    }
    return totalItems > 0
      ? Math.min(100, Math.round((totalProcessed / totalItems) * 100))
      : 0;
  })();

  const totalRunningFor = allLibs.reduce(
    (max, l) => Math.max(max, l.runningFor),
    0
  );

  const borderColor = getBorderColor(overallState);
  const progressBarColor = getProgressBarColor(overallState);

  const eta =
    activeLib?.estimatedSecondsRemaining != null
      ? formatTime(activeLib.estimatedSecondsRemaining)
      : null;

  return (
    <div
      className={`rounded-lg border-2 ${borderColor} bg-stone-800 p-6 shadow-sm transition-all`}
    >
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">Overlay Sync</h3>
          <p className="text-xs text-gray-400">
            {pending
              ? 'Waiting for collections...'
              : getStateLabel(overallState)}
          </p>
        </div>
        {isActive ? (
          <Button
            buttonType="danger"
            buttonSize="sm"
            onClick={handleStop}
            disabled={isStopping || overallState === 'cancelling'}
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

      {/* Progress Bar */}
      <div className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-gray-300">Progress</span>
          <span className="text-xs text-gray-400">{overallProgress}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-gray-700">
          {isActive && overallProgress === 0 ? (
            <div
              className={`h-full w-1/3 animate-pulse rounded-full ${progressBarColor}`}
            />
          ) : (
            <div
              className={`h-full transition-all duration-300 ${progressBarColor}`}
              style={{ width: `${overallProgress}%` }}
            />
          )}
        </div>
      </div>

      {/* Current Library Panel */}
      {activeLib && (
        <div className="mb-4 rounded-md bg-stone-900 p-3">
          <p className="text-xs text-gray-500">Processing</p>
          <p className="truncate text-sm font-medium text-white">
            {activeLib.currentTitle || activeLib.libraryName}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <span className="rounded bg-stone-700 px-1.5 py-0.5 text-[10px] font-medium text-gray-300">
              {activeLib.libraryName}
            </span>
            {jobStatus && jobStatus.totalLibraries > 1 && (
              <span className="text-xs text-gray-500">
                Library{' '}
                {Math.min(
                  jobStatus.processedLibraries + 1,
                  jobStatus.totalLibraries
                )}{' '}
                of {jobStatus.totalLibraries}
              </span>
            )}
            <span className="text-xs text-gray-500">
              Item {activeLib.currentItem} of {activeLib.totalItems}
            </span>
          </div>
        </div>
      )}

      <OverlayLibraryProgressList libraries={allLibs} />

      <OverlayOutcomeStats
        counts={{
          success: totalSuccess,
          error: totalErrors,
          skipped: totalSkipped,
          filtered: totalFiltered,
        }}
        libraryIds={allLibs.map((library) => library.libraryId)}
        isRunning={isActive}
      />

      {/* Footer */}
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>
          {isActive
            ? `Processed ${totalProcessed} / ${totalItems}`
            : `${formatTime(totalRunningFor)} elapsed`}
        </span>
        {isActive && eta ? (
          <span>
            ETA: <span className="text-gray-300">{eta}</span>
          </span>
        ) : !isActive && allLibs.length > 0 ? (
          <span>
            {formatTimeAgo(
              Math.max(...allLibs.map((l) => l.startTime + l.runningFor * 1000))
            )}
          </span>
        ) : null}
      </div>
    </div>
  );
};

export default OverlaySyncCard;

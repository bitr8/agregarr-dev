import Button from '@app/components/Common/Button';
import { formatTime } from '@app/utils/timeFormatters';
import {
  CheckIcon,
  ExclamationTriangleIcon,
  ForwardIcon,
  FunnelIcon,
  PlayIcon,
  StopIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import type React from 'react';
import { useRef, useState } from 'react';
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
  filteredCount: number;
  successCount: number;
  errorCount: number;
  skippedCount: number;
  progressPercent: number;
  estimatedSecondsRemaining: number | null;
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

  const liveLibs = data?.runningLibraries || [];
  const jobStatus = data?.jobStatus;
  const pending = data?.pending || false;

  const lastSnapshotRef = useRef<LibraryStatus[]>([]);
  if (liveLibs.length > 0) {
    lastSnapshotRef.current = liveLibs;
  }
  const allLibs =
    liveLibs.length > 0
      ? liveLibs
      : !jobStatus?.running && !pending
      ? lastSnapshotRef.current
      : [];

  const activeLib = liveLibs.find(
    (lib) => lib.state === 'running' || lib.state === 'cancelling'
  );
  const isActive = !!activeLib || !!jobStatus?.running || pending;
  const overallState: OverlayState = pending
    ? 'running'
    : jobStatus?.running
    ? activeLib?.state === 'cancelling'
      ? 'cancelling'
      : 'running'
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
      await axios.post('/api/v1/settings/jobs/overlay-application/cancel');
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

  const overallProgress =
    totalItems > 0
      ? Math.min(100, Math.round((totalProcessed / totalItems) * 100))
      : overallState === 'completed'
      ? 100
      : 0;

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

      {/* Stats Grid */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-md bg-stone-900 p-3">
          <div className="flex items-center gap-2">
            <CheckIcon className="h-4 w-4 text-green-400" />
            <span className="text-xs text-gray-400">Success</span>
          </div>
          <p className="mt-1 text-lg font-semibold text-green-400">
            {totalSuccess}
          </p>
        </div>

        <div className="rounded-md bg-stone-900 p-3">
          <div className="flex items-center gap-2">
            <ExclamationTriangleIcon className="h-4 w-4 text-red-400" />
            <span className="text-xs text-gray-400">Errors</span>
          </div>
          <p className="mt-1 text-lg font-semibold text-red-400">
            {totalErrors}
          </p>
        </div>

        <div className="rounded-md bg-stone-900 p-3">
          <div className="flex items-center gap-2">
            <ForwardIcon className="h-4 w-4 text-amber-400" />
            <span className="text-xs text-gray-400">Unchanged</span>
          </div>
          <p className="mt-1 text-lg font-semibold text-amber-400">
            {totalSkipped}
          </p>
        </div>

        <div className="rounded-md bg-stone-900 p-3">
          <div className="flex items-center gap-2">
            <FunnelIcon className="h-4 w-4 text-blue-400" />
            <span className="text-xs text-gray-400">Filtered</span>
          </div>
          <p className="mt-1 text-lg font-semibold text-blue-400">
            {totalFiltered}
          </p>
        </div>
      </div>

      {/* Per-Library Breakdown */}
      {allLibs.length > 1 && (
        <div className="mb-4">
          <p className="mb-2 text-xs font-medium text-gray-300">Libraries</p>
          <div className="space-y-1">
            {allLibs.map((lib) => (
              <div
                key={lib.libraryId}
                className="flex items-center gap-2 text-xs"
              >
                {lib.state === 'completed' ? (
                  <CheckIcon className="h-3.5 w-3.5 text-green-400" />
                ) : lib.state === 'failed' ? (
                  <ExclamationTriangleIcon className="h-3.5 w-3.5 text-red-400" />
                ) : lib.state === 'running' ? (
                  <div className="h-3.5 w-3.5 animate-pulse rounded-full bg-orange-400" />
                ) : (
                  <ForwardIcon className="h-3.5 w-3.5 text-gray-500" />
                )}
                <span className="min-w-0 flex-1 truncate text-gray-300">
                  {lib.libraryName}
                </span>
                <span className="shrink-0 text-gray-500">
                  {lib.successCount +
                    lib.errorCount +
                    lib.skippedCount +
                    lib.filteredCount}
                  /{lib.totalItems}
                </span>
                <span className="shrink-0 text-gray-500">
                  {formatTime(lib.runningFor)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>
          {isActive
            ? `Processed ${totalProcessed} / ${totalItems}`
            : `${formatTime(totalRunningFor)} elapsed`}
        </span>
        {eta && (
          <span>
            ETA: <span className="text-gray-300">{eta}</span>
          </span>
        )}
      </div>
    </div>
  );
};

export default OverlaySyncCard;

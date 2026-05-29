import Spinner from '@app/assets/spinner.svg';
import Tooltip from '@app/components/Common/Tooltip';
import type {
  CollectionSyncStatus,
  SyncProgressResponse,
} from '@app/utils/collections/syncProgressTypes';
import { formatTime } from '@app/utils/timeFormatters';
import {
  CheckIcon,
  ExclamationTriangleIcon,
  ForwardIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import Link from 'next/link';
import React, { useCallback } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages({
  lastSyncFailed: 'Last sync failed',
  collectionsNeedingSync:
    '{count, plural, one {# collection pending} other {# collections pending}}',
  lastSync: 'Last sync: {time}',
  nextSync: 'Next sync: {time}',
  noSyncYet: 'No sync yet',
});

interface GlobalSyncStatusResponse {
  running: boolean;
  currentStage?: string;
  totalCollections?: number;
  processedCollections?: number;
  progress?: number;
  lastGlobalSyncAt?: string;
  globalSyncError?: string;
  collectionsNeedingSync: number;
  nextSyncAt?: string;
}

interface GlobalSyncStatusProps {
  isStarting?: boolean;
  onSyncStart?: (refreshFn: () => void) => void;
  onSyncComplete?: () => void;
}

const LastSyncSummary: React.FC<{ status: CollectionSyncStatus }> = ({
  status,
}) => {
  const errorOutcomes = status.recentOutcomes.filter(
    (o) => o.outcome === 'error'
  );

  const errorTooltip =
    errorOutcomes.length > 0 ? (
      <div className="max-w-xs space-y-1">
        {errorOutcomes.map((o, i) => (
          <div key={i}>
            <span className="font-medium">{o.name}</span>
            {o.errorMessage && (
              <span className="block text-gray-400">{o.errorMessage}</span>
            )}
          </div>
        ))}
        {status.errorCount > errorOutcomes.length && (
          <span className="block text-xs italic text-gray-500">
            +{status.errorCount - errorOutcomes.length} older errors
          </span>
        )}
      </div>
    ) : null;

  return (
    <span className="flex items-center gap-1.5 text-gray-500">
      &mdash;
      <span className="flex items-center gap-0.5">
        <CheckIcon className="h-3 w-3 text-green-400" />
        {status.successCount}
      </span>
      {status.errorCount > 0 &&
        (errorTooltip ? (
          <Tooltip content={errorTooltip}>
            <span className="flex cursor-help items-center gap-0.5 text-red-400">
              <ExclamationTriangleIcon className="h-3 w-3" />
              {status.errorCount}
            </span>
          </Tooltip>
        ) : (
          <span className="flex items-center gap-0.5 text-red-400">
            <ExclamationTriangleIcon className="h-3 w-3" />
            {status.errorCount}
          </span>
        ))}
      {status.skippedCount > 0 && (
        <span className="flex items-center gap-0.5">
          <ForwardIcon className="h-3 w-3 text-amber-400" />
          {status.skippedCount}
        </span>
      )}
      <span className="text-gray-600">({formatTime(status.runningFor)})</span>
    </span>
  );
};

const GlobalSyncStatus: React.FC<GlobalSyncStatusProps> = ({
  isStarting = false,
  onSyncStart,
  onSyncComplete,
}) => {
  const intl = useIntl();
  const { data: syncStatus, mutate } = useSWR<GlobalSyncStatusResponse>(
    '/api/v1/collections/sync/status',
    (url: string) => axios.get(url).then((res) => res.data),
    {
      refreshInterval: (data) => (data?.running ? 1000 : 5000), // Refresh every 1 second while running, 5 seconds when idle
    }
  );

  const { data: progressData, mutate: mutateProgress } =
    useSWR<SyncProgressResponse>(
      '/api/v1/collections/sync/progress',
      (url: string) => axios.get(url).then((res) => res.data),
      {
        refreshInterval: () => (syncStatus?.running ? 0 : 10000),
        revalidateOnFocus: false,
      }
    );

  const lastCompleted = progressData?.lastCompleted ?? null;

  // Create a stable callback function
  const refreshSync = useCallback(() => {
    mutate();
  }, [mutate]);

  // Track previous running state to detect completion
  const prevRunningRef = React.useRef<boolean>();

  // Expose the mutate function to parent via callback
  React.useEffect(() => {
    if (onSyncStart) {
      onSyncStart(refreshSync);
    }
  }, [onSyncStart, refreshSync]);

  // Detect sync completion and trigger callback
  React.useEffect(() => {
    const wasRunning = prevRunningRef.current;
    const isRunning = syncStatus?.running;

    if (wasRunning === true && isRunning === false) {
      mutateProgress();
      onSyncComplete?.();
    }

    prevRunningRef.current = isRunning;
  }, [syncStatus?.running, onSyncComplete, mutateProgress]);

  if (!syncStatus) {
    return null;
  }

  const formatRelativeTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffInMs = now.getTime() - date.getTime();
    const diffInMinutes = Math.floor(diffInMs / (1000 * 60));
    const diffInHours = Math.floor(diffInMinutes / 60);
    const diffInDays = Math.floor(diffInHours / 24);

    if (diffInMinutes < 1) {
      return 'Just now';
    } else if (diffInMinutes < 60) {
      return `${diffInMinutes} minute${diffInMinutes === 1 ? '' : 's'} ago`;
    } else if (diffInHours < 24) {
      return `${diffInHours} hour${diffInHours === 1 ? '' : 's'} ago`;
    } else {
      return `${diffInDays} day${diffInDays === 1 ? '' : 's'} ago`;
    }
  };

  const formatFutureTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffInMs = date.getTime() - now.getTime();
    const diffInMinutes = Math.floor(diffInMs / (1000 * 60));
    const remainingMinutes = diffInMinutes % 60;

    // Round to nearest hour based on 30-minute threshold
    const diffInHours =
      remainingMinutes >= 30
        ? Math.ceil(diffInMinutes / 60)
        : Math.floor(diffInMinutes / 60);

    const diffInDays = Math.floor(diffInHours / 24);

    if (diffInMs < 0) {
      return 'Overdue';
    } else if (diffInMinutes < 1) {
      return 'Soon';
    } else if (diffInMinutes < 60) {
      return `in ${diffInMinutes} minute${diffInMinutes === 1 ? '' : 's'}`;
    } else if (diffInHours < 24) {
      const exactHours = Math.floor(diffInMinutes / 60);
      if (exactHours < 2 && remainingMinutes > 0) {
        return `in ${exactHours} hour${
          exactHours === 1 ? '' : 's'
        } ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}`;
      } else {
        return `in ${diffInHours} hour${diffInHours === 1 ? '' : 's'}`;
      }
    } else {
      return `in ${diffInDays} day${diffInDays === 1 ? '' : 's'}`;
    }
  };

  return (
    <div className="flex items-center space-x-3 text-xs text-gray-400">
      {/* Show immediate placeholder when starting */}
      {isStarting && !syncStatus?.running && (
        <div className="flex items-center space-x-2">
          <Spinner className="h-3 w-3 animate-spin" />
          <span>Starting sync...</span>
        </div>
      )}

      {/* Currently Running with Progress */}
      {syncStatus?.running && (
        <div className="flex items-center space-x-2">
          <Spinner className="h-3 w-3 animate-spin" />
          <span>
            {syncStatus.currentStage || 'Syncing...'}
            {syncStatus.totalCollections &&
              syncStatus.totalCollections > 0 &&
              syncStatus.processedCollections !== undefined && (
                <span className="ml-1">
                  ({syncStatus.processedCollections}/
                  {syncStatus.totalCollections})
                </span>
              )}
          </span>
          <Link
            href="/dashboard"
            className="text-indigo-400 hover:text-indigo-300"
          >
            View on Dashboard
          </Link>
        </div>
      )}

      {/* Sync Error Display */}
      {!syncStatus?.running && syncStatus?.globalSyncError && (
        <div className="flex items-center space-x-1">
          <ExclamationTriangleIcon className="h-3 w-3" />
          <span title={syncStatus.globalSyncError}>
            {intl.formatMessage(messages.lastSyncFailed)}
          </span>
        </div>
      )}

      {/* Collections Needing Sync Count - Only when not running and no error */}
      {!syncStatus?.running &&
        !syncStatus?.globalSyncError &&
        (syncStatus?.collectionsNeedingSync || 0) > 0 && (
          <span>
            {intl.formatMessage(messages.collectionsNeedingSync, {
              count: syncStatus.collectionsNeedingSync,
            })}
          </span>
        )}

      {/* Last Sync Time - Only when not running and no pending/errors */}
      {!syncStatus?.running &&
        !syncStatus?.globalSyncError &&
        (syncStatus?.collectionsNeedingSync || 0) === 0 &&
        syncStatus?.lastGlobalSyncAt && (
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <span>
                {intl.formatMessage(messages.lastSync, {
                  time: formatRelativeTime(syncStatus.lastGlobalSyncAt),
                })}
              </span>
              {lastCompleted && <LastSyncSummary status={lastCompleted} />}
            </div>
            {syncStatus?.nextSyncAt && (
              <span>
                {intl.formatMessage(messages.nextSync, {
                  time: formatFutureTime(syncStatus.nextSyncAt),
                })}
              </span>
            )}
          </div>
        )}

      {/* Never Synced - Only when not running and no pending/errors */}
      {!syncStatus?.running &&
        !syncStatus?.globalSyncError &&
        (syncStatus?.collectionsNeedingSync || 0) === 0 &&
        !syncStatus?.lastGlobalSyncAt && (
          <div className="flex flex-col">
            <span>{intl.formatMessage(messages.noSyncYet)}</span>
            {/* Next Sync Time - Only show if we have a next sync time */}
            {syncStatus?.nextSyncAt && (
              <span>
                {intl.formatMessage(messages.nextSync, {
                  time: formatFutureTime(syncStatus.nextSyncAt),
                })}
              </span>
            )}
          </div>
        )}
    </div>
  );
};

export default GlobalSyncStatus;

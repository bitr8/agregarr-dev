import { formatTimeAgo } from '@app/utils/timeFormatters';
import {
  CheckIcon,
  ExclamationTriangleIcon,
  ForwardIcon,
} from '@heroicons/react/24/outline';
import type React from 'react';
import useSWR from 'swr';

interface JobHistoryRow {
  jobId: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  outcome: string;
  error: string | null;
  detail: Record<string, unknown> | null;
}

const JOB_LABELS: Record<string, string> = {
  'plex-collections-quick-sync': 'Collections Quick Sync',
  'overlay-quick-sync': 'Overlay Quick Sync',
  'health-checks': 'Health Checks',
  'plex-refresh-token': 'Token Refresh',
  'plex-randomize-home-order': 'Randomize Home',
  'watchlist-sync': 'Watchlist Sync',
};

const SYNC_JOB_IDS = new Set(['plex-collections-sync', 'overlay-application']);

const getOutcomeIcon = (outcome: string) => {
  switch (outcome) {
    case 'success':
      return <CheckIcon className="h-3.5 w-3.5 text-green-400" />;
    case 'error':
      return <ExclamationTriangleIcon className="h-3.5 w-3.5 text-red-400" />;
    case 'skipped':
      return <ForwardIcon className="h-3.5 w-3.5 text-amber-400" />;
    default:
      return <CheckIcon className="h-3.5 w-3.5 text-gray-500" />;
  }
};

const formatDetail = (row: JobHistoryRow): string | null => {
  const d = row.detail;
  if (!d) return null;

  switch (row.jobId) {
    case 'plex-collections-quick-sync': {
      const matched = (d.itemsMatched as number) ?? 0;
      const added = (d.itemsAdded as number) ?? 0;
      if (matched === 0 && added === 0) return '0 matched';
      return `${matched} matched, ${added} added`;
    }
    case 'overlay-quick-sync': {
      const items = (d.itemsProcessed as number) ?? 0;
      return `${items} item${items !== 1 ? 's' : ''}`;
    }
    default:
      return null;
  }
};

const RecentActivityCard: React.FC = () => {
  const { data, error } = useSWR<JobHistoryRow[]>(
    '/api/v1/dashboard/job-history',
    {
      refreshInterval: 30000,
      revalidateOnFocus: false,
    }
  );

  const jobs = data
    ?.filter((r) => !SYNC_JOB_IDS.has(r.jobId))
    .sort(
      (a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );

  if (error || !jobs || jobs.length === 0) return null;

  return (
    <div className="rounded-lg border-2 border-stone-700 bg-stone-800 p-6 shadow-sm">
      <h3 className="mb-3 text-lg font-semibold text-white">Job Status</h3>
      <div className="space-y-2">
        {jobs.map((row) => {
          const detail = formatDetail(row);
          return (
            <div key={row.jobId} className="flex items-center gap-2 text-xs">
              {getOutcomeIcon(row.outcome)}
              <span className="min-w-0 flex-1 truncate text-gray-300">
                {JOB_LABELS[row.jobId] ?? row.jobId}
              </span>
              {detail && (
                <span className="shrink-0 text-gray-500">{detail}</span>
              )}
              {row.outcome === 'error' && row.error && (
                <span
                  className="max-w-[140px] shrink-0 truncate text-red-400"
                  title={row.error}
                >
                  {row.error}
                </span>
              )}
              {row.finishedAt && (
                <span className="shrink-0 text-gray-600">
                  {formatTimeAgo(new Date(row.finishedAt).getTime())}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default RecentActivityCard;

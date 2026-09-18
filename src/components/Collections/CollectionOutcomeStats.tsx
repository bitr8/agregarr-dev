import { formatDurationMs } from '@app/utils/timeFormatters';
import {
  ArrowDownTrayIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
  ForwardIcon,
  MagnifyingGlassIcon,
  PlusIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import type React from 'react';
import { useMemo, useState } from 'react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';
import useSWR from 'swr';

type CollectionOutcomeKind = 'success' | 'error' | 'skipped' | 'created';

type CollectionOutcomeCounts = Record<CollectionOutcomeKind, number>;

interface CollectionOutcomeItem {
  configId: string;
  name: string;
  sourceType: string;
  outcome: 'success' | 'error' | 'skipped';
  created: number;
  updated: number;
  errorMessage?: string;
  durationMs: number;
  processedAt: number;
}

interface CollectionOutcomeResponse {
  outcome: CollectionOutcomeKind;
  total: number;
  outcomes: CollectionOutcomeItem[];
}

interface CollectionOutcomeStatsProps {
  counts: CollectionOutcomeCounts;
  isRunning?: boolean;
}

const messages = defineMessages({
  collectionResults: 'Collection results',
  preparing: 'Preparing...',
  downloadCsv: 'Download CSV log',
  downloadFailed: 'Failed to download the sync log.',
  synced: 'Synced',
  errors: 'Errors',
  skipped: 'Skipped',
  created: 'Created',
  syncedLower: 'synced',
  errored: 'errored',
  skippedLower: 'skipped',
  createdLower: 'created',
  loadingDetails: 'Loading collection details...',
  loadDetailsFailed: 'Failed to load collection details.',
  noRecordedCollections: 'No {outcome} collections recorded for this run.',
  searchPlaceholder: 'Search {outcome} by name, source, or config ID',
  showingEntries: 'Showing {shown} of {total} entries',
  noMatches: 'No collections match “{searchTerm}”.',
  itemSummary: 'Created {created} · Updated {updated} · Config {configId}',
});

const definitions: {
  outcome: CollectionOutcomeKind;
  label: MessageDescriptor;
  emptyLabel: MessageDescriptor;
  color: string;
  activeBorder: string;
  icon: typeof CheckIcon;
}[] = [
  {
    outcome: 'success',
    label: messages.synced,
    emptyLabel: messages.syncedLower,
    color: 'text-green-400',
    activeBorder: 'border-green-500',
    icon: CheckIcon,
  },
  {
    outcome: 'error',
    label: messages.errors,
    emptyLabel: messages.errored,
    color: 'text-red-400',
    activeBorder: 'border-red-500',
    icon: ExclamationTriangleIcon,
  },
  {
    outcome: 'skipped',
    label: messages.skipped,
    emptyLabel: messages.skippedLower,
    color: 'text-amber-400',
    activeBorder: 'border-amber-500',
    icon: ForwardIcon,
  },
  {
    outcome: 'created',
    label: messages.created,
    emptyLabel: messages.createdLower,
    color: 'text-blue-400',
    activeBorder: 'border-blue-500',
    icon: PlusIcon,
  },
];

const CollectionOutcomeStats: React.FC<CollectionOutcomeStatsProps> = ({
  counts,
  isRunning = false,
}) => {
  const intl = useIntl();
  const [openOutcome, setOpenOutcome] = useState<CollectionOutcomeKind | null>(
    null
  );
  const [searchTerm, setSearchTerm] = useState('');
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const detailsUrl = openOutcome
    ? `/api/v1/collections/sync/outcomes?outcome=${openOutcome}`
    : null;
  const { data, error, isLoading } = useSWR<CollectionOutcomeResponse>(
    detailsUrl,
    (url: string) =>
      axios
        .get<CollectionOutcomeResponse>(url)
        .then((response) => response.data),
    {
      refreshInterval: isRunning ? 1000 : 0,
      revalidateOnFocus: false,
    }
  );
  const selectedDefinition = definitions.find(
    (definition) => definition.outcome === openOutcome
  );
  const filteredOutcomes = useMemo(() => {
    if (!data) return [];
    const query = searchTerm.trim().toLocaleLowerCase();
    if (!query) return data.outcomes;

    return data.outcomes.filter((outcome) =>
      [
        outcome.name,
        outcome.configId,
        outcome.sourceType,
        outcome.outcome,
        outcome.errorMessage,
      ].some((value) => value?.toLocaleLowerCase().includes(query))
    );
  }, [data, searchTerm]);

  const handleDownload = async () => {
    if (isDownloading) return;
    setIsDownloading(true);
    setDownloadError(false);

    try {
      const response = await axios.get<Blob>(
        '/api/v1/collections/sync/outcomes/export',
        { responseType: 'blob' }
      );
      const contentDisposition = response.headers['content-disposition'] as
        | string
        | undefined;
      const filename =
        contentDisposition?.match(/filename="([^"]+)"/)?.[1] ||
        'agregarr-collection-sync.csv';
      const downloadUrl = URL.createObjectURL(response.data);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(downloadUrl);
    } catch {
      setDownloadError(true);
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div className="mb-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-gray-300">
          {intl.formatMessage(messages.collectionResults)}
        </p>
        <button
          type="button"
          onClick={handleDownload}
          disabled={isDownloading}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ArrowDownTrayIcon className="h-4 w-4" />
          {intl.formatMessage(
            isDownloading ? messages.preparing : messages.downloadCsv
          )}
        </button>
      </div>
      {downloadError && (
        <p className="mb-2 text-right text-xs text-red-400">
          {intl.formatMessage(messages.downloadFailed)}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {definitions.map((definition) => {
          const Icon = definition.icon;
          const isOpen = openOutcome === definition.outcome;

          return (
            <button
              key={definition.outcome}
              type="button"
              aria-expanded={isOpen}
              onClick={() => {
                setOpenOutcome(isOpen ? null : definition.outcome);
                setSearchTerm('');
              }}
              className={`min-w-0 rounded-md border bg-stone-900 p-3 text-left transition-colors hover:bg-stone-800 focus:outline-none focus:ring-2 focus:ring-orange-500 ${
                isOpen ? definition.activeBorder : 'border-transparent'
              }`}
            >
              <div className="flex min-w-0 items-center gap-2">
                <Icon className={`h-4 w-4 shrink-0 ${definition.color}`} />
                <span className="min-w-0 truncate text-xs text-gray-400">
                  {intl.formatMessage(definition.label)}
                </span>
                {isOpen ? (
                  <ChevronDownIcon className="ml-auto h-3.5 w-3.5 shrink-0 text-gray-500" />
                ) : (
                  <ChevronRightIcon className="ml-auto h-3.5 w-3.5 shrink-0 text-gray-500" />
                )}
              </div>
              <p
                className={`mt-1 truncate text-lg font-semibold tabular-nums ${definition.color}`}
              >
                {counts[definition.outcome]}
              </p>
            </button>
          );
        })}
      </div>

      {openOutcome && selectedDefinition && (
        <div className="mt-2 rounded-md border border-stone-700 bg-stone-900 p-3">
          {isLoading ? (
            <p className="text-xs text-gray-400">
              {intl.formatMessage(messages.loadingDetails)}
            </p>
          ) : error ? (
            <p className="text-xs text-red-400">
              {intl.formatMessage(messages.loadDetailsFailed)}
            </p>
          ) : !data || data.total === 0 ? (
            <p className="text-xs text-gray-400">
              {intl.formatMessage(messages.noRecordedCollections, {
                outcome: intl.formatMessage(selectedDefinition.emptyLabel),
              })}
            </p>
          ) : (
            <div className="space-y-3">
              <div>
                <div className="relative">
                  <MagnifyingGlassIcon className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-gray-500" />
                  <input
                    type="search"
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.target.value)}
                    placeholder={intl.formatMessage(
                      messages.searchPlaceholder,
                      {
                        outcome: intl
                          .formatMessage(selectedDefinition.label)
                          .toLocaleLowerCase(),
                      }
                    )}
                    className="w-full rounded-md border border-stone-700 bg-stone-800 py-1.5 pl-8 pr-3 text-xs text-white placeholder-gray-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                  />
                </div>
                <p className="mt-1 text-[10px] text-gray-500">
                  {intl.formatMessage(messages.showingEntries, {
                    shown: filteredOutcomes.length,
                    total: data.total,
                  })}
                </p>
              </div>

              {filteredOutcomes.length === 0 ? (
                <p className="text-xs text-gray-400">
                  {intl.formatMessage(messages.noMatches, { searchTerm })}
                </p>
              ) : (
                <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
                  {filteredOutcomes.map((outcome, index) => (
                    <div
                      key={`${outcome.configId}:${outcome.processedAt}:${index}`}
                      className="rounded bg-stone-800 px-2 py-1.5 text-xs"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-gray-200">
                          {outcome.name}
                        </span>
                        <span className="shrink-0 rounded bg-stone-700 px-1.5 py-0.5 text-[10px] text-gray-400">
                          {outcome.sourceType}
                        </span>
                        <span className="shrink-0 text-[10px] text-gray-500">
                          {formatDurationMs(outcome.durationMs)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[10px] text-gray-500">
                        {intl.formatMessage(messages.itemSummary, {
                          created: outcome.created,
                          updated: outcome.updated,
                          configId: outcome.configId,
                        })}
                      </p>
                      {outcome.errorMessage && (
                        <p className="mt-0.5 text-[10px] text-red-400">
                          {outcome.errorMessage}
                        </p>
                      )}
                      <p className="mt-0.5 text-[10px] text-gray-600">
                        {new Date(outcome.processedAt).toLocaleTimeString()}
                      </p>
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
};

export default CollectionOutcomeStats;

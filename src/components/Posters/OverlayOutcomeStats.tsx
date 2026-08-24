import {
  ArrowDownTrayIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
  ForwardIcon,
  FunnelIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
import type { OverlayArtworkTarget } from '@server/lib/overlays/overlayTargets';
import axios from 'axios';
import type React from 'react';
import { useMemo, useState } from 'react';
import useSWR from 'swr';

export type OverlayOutcomeKind = 'success' | 'error' | 'skipped' | 'filtered';

export type OverlayOutcomeCounts = Record<OverlayOutcomeKind, number>;

interface OverlayOutcomeItem {
  title: string;
  ratingKey: string;
  target: OverlayArtworkTarget;
  outcome: OverlayOutcomeKind;
  processedAt: number;
  message?: string;
  filePath?: string;
}

interface OverlayOutcomeResponse {
  outcome: OverlayOutcomeKind;
  total: number;
  libraries: {
    libraryId: string;
    libraryName: string;
    items: OverlayOutcomeItem[];
  }[];
}

interface OverlayOutcomeStatsProps {
  counts: OverlayOutcomeCounts;
  libraryIds: string[];
  isRunning?: boolean;
}

const definitions: {
  outcome: OverlayOutcomeKind;
  label: string;
  emptyLabel: string;
  color: string;
  activeBorder: string;
  icon: typeof CheckIcon;
}[] = [
  {
    outcome: 'success',
    label: 'Success',
    emptyLabel: 'successful',
    color: 'text-green-400',
    activeBorder: 'border-green-500',
    icon: CheckIcon,
  },
  {
    outcome: 'error',
    label: 'Errors',
    emptyLabel: 'errored',
    color: 'text-red-400',
    activeBorder: 'border-red-500',
    icon: ExclamationTriangleIcon,
  },
  {
    outcome: 'skipped',
    label: 'Unchanged',
    emptyLabel: 'unchanged',
    color: 'text-amber-400',
    activeBorder: 'border-amber-500',
    icon: ForwardIcon,
  },
  {
    outcome: 'filtered',
    label: 'Filtered',
    emptyLabel: 'filtered',
    color: 'text-blue-400',
    activeBorder: 'border-blue-500',
    icon: FunnelIcon,
  },
];

const OverlayOutcomeStats: React.FC<OverlayOutcomeStatsProps> = ({
  counts,
  libraryIds,
  isRunning = false,
}) => {
  const [openOutcome, setOpenOutcome] = useState<OverlayOutcomeKind | null>(
    null
  );
  const [searchTerm, setSearchTerm] = useState('');
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const libraryIdQuery = libraryIds.join(',');
  const detailsUrl = openOutcome
    ? `/api/v1/overlay-library-configs/status/outcomes?outcome=${openOutcome}&libraryIds=${encodeURIComponent(
        libraryIdQuery
      )}`
    : null;
  const { data, error, isLoading } = useSWR<OverlayOutcomeResponse>(
    detailsUrl,
    (url: string) =>
      axios.get<OverlayOutcomeResponse>(url).then((response) => response.data),
    {
      refreshInterval: isRunning ? 1000 : 0,
      revalidateOnFocus: false,
    }
  );
  const selectedDefinition = definitions.find(
    (definition) => definition.outcome === openOutcome
  );
  const filteredLibraries = useMemo(() => {
    if (!data) return [];
    const query = searchTerm.trim().toLocaleLowerCase();

    return data.libraries
      .map((library) => ({
        ...library,
        items: query
          ? library.items.filter((item) =>
              [
                library.libraryName,
                item.title,
                item.filePath,
                item.ratingKey,
                item.message,
                item.target,
              ].some((value) => value?.toLocaleLowerCase().includes(query))
            )
          : library.items,
      }))
      .filter((library) => library.items.length > 0);
  }, [data, searchTerm]);
  const filteredTotal = filteredLibraries.reduce(
    (total, library) => total + library.items.length,
    0
  );

  const handleDownload = async () => {
    if (isDownloading || libraryIds.length === 0) return;
    setIsDownloading(true);
    setDownloadError(false);

    try {
      const response = await axios.get<Blob>(
        `/api/v1/overlay-library-configs/status/outcomes/export?libraryIds=${encodeURIComponent(
          libraryIdQuery
        )}`,
        { responseType: 'blob' }
      );
      const contentDisposition = response.headers['content-disposition'] as
        | string
        | undefined;
      const filename =
        contentDisposition?.match(/filename="([^"]+)"/)?.[1] ||
        'agregarr-overlay-sync.csv';
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
        <p className="text-xs font-medium text-gray-300">Item results</p>
        <button
          type="button"
          onClick={handleDownload}
          disabled={isDownloading || libraryIds.length === 0}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ArrowDownTrayIcon className="h-4 w-4" />
          {isDownloading ? 'Preparing...' : 'Download CSV log'}
        </button>
      </div>
      {downloadError && (
        <p className="mb-2 text-right text-xs text-red-400">
          Failed to download the sync log.
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
              className={`rounded-md border bg-stone-900 p-3 text-left transition-colors hover:bg-stone-800 focus:outline-none focus:ring-2 focus:ring-orange-500 ${
                isOpen ? definition.activeBorder : 'border-transparent'
              }`}
            >
              <div className="flex items-center gap-2">
                <Icon className={`h-4 w-4 ${definition.color}`} />
                <span className="text-xs text-gray-400">
                  {definition.label}
                </span>
                {isOpen ? (
                  <ChevronDownIcon className="ml-auto h-3.5 w-3.5 text-gray-500" />
                ) : (
                  <ChevronRightIcon className="ml-auto h-3.5 w-3.5 text-gray-500" />
                )}
              </div>
              <p className={`mt-1 text-lg font-semibold ${definition.color}`}>
                {counts[definition.outcome]}
              </p>
            </button>
          );
        })}
      </div>

      {openOutcome && selectedDefinition && (
        <div className="mt-2 rounded-md border border-stone-700 bg-stone-900 p-3">
          {isLoading ? (
            <p className="text-xs text-gray-400">Loading item details...</p>
          ) : error ? (
            <p className="text-xs text-red-400">Failed to load item details.</p>
          ) : !data || data.total === 0 ? (
            <p className="text-xs text-gray-400">
              No {selectedDefinition.emptyLabel} items recorded for this run.
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
                    placeholder={`Search ${selectedDefinition.label.toLowerCase()} by title, file, Plex key, or library`}
                    className="w-full rounded-md border border-stone-700 bg-stone-800 py-1.5 pl-8 pr-3 text-xs text-white placeholder-gray-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                  />
                </div>
                <p className="mt-1 text-[10px] text-gray-500">
                  Showing {filteredTotal} of {data.total} items
                </p>
              </div>

              {filteredTotal === 0 ? (
                <p className="text-xs text-gray-400">
                  No items match &ldquo;{searchTerm}&rdquo;.
                </p>
              ) : (
                <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
                  {filteredLibraries.map((library) => (
                    <div key={library.libraryId}>
                      <p className="mb-1 text-xs font-semibold text-gray-300">
                        {library.libraryName}
                      </p>
                      <div className="space-y-1">
                        {library.items.map((item, index) => (
                          <div
                            key={`${item.target}:${item.ratingKey}:${index}`}
                            className="rounded bg-stone-800 px-2 py-1.5 text-xs"
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-gray-200">
                                {item.title}
                              </span>
                              <span className="ml-auto shrink-0 rounded bg-stone-700 px-1.5 py-0.5 text-[10px] uppercase text-gray-400">
                                {item.target === 'main'
                                  ? 'poster'
                                  : item.target}
                              </span>
                            </div>
                            <p className="mt-0.5 break-all text-[10px] text-gray-500">
                              {item.filePath || `Plex key: ${item.ratingKey}`}
                            </p>
                            {item.message && (
                              <p className="mt-0.5 text-[10px] text-gray-500">
                                {item.message}
                              </p>
                            )}
                            <p className="mt-0.5 text-[10px] text-gray-600">
                              {new Date(item.processedAt).toLocaleTimeString()}
                            </p>
                          </div>
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
};

export default OverlayOutcomeStats;

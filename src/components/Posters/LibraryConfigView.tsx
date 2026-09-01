import Spinner from '@app/assets/spinner.svg';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import {
  ArrowUturnLeftIcon,
  ExclamationTriangleIcon,
  PlayIcon,
  TrashIcon,
} from '@heroicons/react/24/solid';
import {
  normalizeOverlaySyncTargets,
  type OverlayArtworkTarget,
} from '@server/lib/overlays/overlayTargets';
import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';
import useSWR, { mutate } from 'swr';
import LibraryDetailConfigView from './LibraryDetailConfigView';
import LibraryProgressCard, { type LibraryStatus } from './LibraryProgressCard';
import PosterResetModal from './PosterResetModal';

const messages = defineMessages({
  loading: 'Loading libraries...',
  noLibraries: 'No libraries found',
  configure: 'Configure',
  overlaysEnabled: '{count} overlays enabled',
  resetPosters: 'Reset Library',
  cyclePoster: 'Cycle Poster',
  syncOverlays: 'Sync',
  syncOverlaysConfirm: 'Confirm?',
  librarySyncStarted: 'Overlay sync started for {libraryName}',
  overlaySyncError: 'Failed to start overlay sync',
  failedToLoad: 'Failed to load libraries',
  noOverlays: 'No overlays configured',
  orphanedSectionTitle: 'Orphaned Configurations',
  orphanedLibraryLabel: 'Removed from Plex',
  configRemoved: 'Removed configuration for {libraryName}',
  removeConfigError: 'Failed to remove configuration',
  removeConfigLabel: 'Remove',
  removeConfigConfirm: 'Delete configuration?',
});

interface PlexLibrary {
  key: string;
  name: string;
  type: 'movie' | 'show';
}

interface LibraryConfig {
  id: number;
  libraryId: string;
  libraryName: string;
  mediaType: 'movie' | 'show';
  enabledOverlays: EnabledOverlay[];
  fullSyncTargets?: OverlayArtworkTarget[];
  quickSyncTargets?: OverlayArtworkTarget[];
}

interface EnabledOverlay {
  templateId: number;
  enabled: boolean;
  layerOrder: number;
  config?: {
    daysThreshold?: number;
    timeWindowDays?: number;
    minimumRating?: number;
    [key: string]: unknown;
  };
}

// Component to show large preview for a library (grid layout)
const LibraryPreviewLarge: React.FC<{
  libraryId: string;
  enabledOverlays: EnabledOverlay[];
  refreshTrigger?: number;
}> = ({ libraryId, enabledOverlays, refreshTrigger = 0 }) => {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const previewUrlRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchPreview = useCallback(async () => {
    const enabledIds = enabledOverlays
      .filter((o) => o.enabled)
      .sort((a, b) => a.layerOrder - b.layerOrder)
      .map((o) => o.templateId);

    if (enabledIds.length === 0) {
      setPreviewUrl(null);
      return;
    }

    // Cancel any in-flight preview request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Create new abort controller for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setLoading(true);
    try {
      const response = await fetch(
        '/api/v1/overlay-templates/combined-preview',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            templateIds: enabledIds,
            contextId: `library-${libraryId}`, // Each library gets its own context
            target: 'main',
          }),
          signal: abortController.signal,
        }
      );

      if (response.ok) {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        setPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          previewUrlRef.current = url;
          return url;
        });
      } else {
        // eslint-disable-next-line no-console
        console.error(
          `Library preview request failed for library ${libraryId}: ${response.status}`
        );
      }
    } catch (error) {
      // Ignore abort errors triggered by cancelled requests
      if (error instanceof Error && error.name !== 'AbortError') {
        // eslint-disable-next-line no-console
        console.error(
          `Library preview request failed for library ${libraryId}:`,
          error
        );
      }
    } finally {
      // Only clear loading if this is still the active request
      if (abortControllerRef.current === abortController) {
        setLoading(false);
        abortControllerRef.current = null;
      }
    }
  }, [enabledOverlays, libraryId]);

  useEffect(() => {
    fetchPreview();
    return () => {
      // Cancel any in-flight request on unmount
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
    };
  }, [fetchPreview, refreshTrigger]);

  return (
    <>
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black bg-opacity-50">
          <LoadingSpinner />
        </div>
      )}
      {previewUrl && (
        <img
          src={previewUrl}
          alt="Overlay preview"
          className="h-full w-full object-cover"
        />
      )}
    </>
  );
};

const LibraryConfigView: React.FC = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(
    null
  );
  const [selectedLibraryName, setSelectedLibraryName] = useState<string>('');
  const [selectedLibraryType, setSelectedLibraryType] = useState<
    'movie' | 'show'
  >('movie');
  const [refreshTriggers, setRefreshTriggers] = useState<
    Record<string, number>
  >({});
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [resetLibraryId, setResetLibraryId] = useState<string>('');
  const [resetLibraryName, setResetLibraryName] = useState<string>('');
  const [syncingLibraries, setSyncingLibraries] = useState<Set<string>>(
    new Set()
  );
  const [confirmClickedLibraries, setConfirmClickedLibraries] = useState<
    Set<string>
  >(new Set());
  const confirmTimeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const [removingLibraries, setRemovingLibraries] = useState<Set<string>>(
    new Set()
  );

  // Poll for running library overlays with full progress status
  const { data: runningLibrariesData, mutate: mutateRunningLibraries } =
    useSWR<{
      runningLibraries: (LibraryStatus & { libraryId: string })[];
    }>('/api/v1/overlay-library-configs/status/all', {
      refreshInterval: 1000, // Poll every second for responsive progress updates
    });

  // Update syncing libraries based on actual status (only running/cancelling, not completed TTL entries)
  useEffect(() => {
    if (runningLibrariesData) {
      const runningIds = new Set(
        runningLibrariesData.runningLibraries
          .filter(
            (lib) => lib.state === 'running' || lib.state === 'cancelling'
          )
          .map((lib) => lib.libraryId)
      );
      setSyncingLibraries(runningIds);
    }
  }, [runningLibrariesData]);

  // Clear confirmation timeouts on unmount
  useEffect(() => {
    const timeouts = confirmTimeoutsRef.current;
    return () => {
      timeouts.forEach((timeout) => clearTimeout(timeout));
      timeouts.clear();
    };
  }, []);

  const handleCyclePoster = (libraryId: string) => {
    setRefreshTriggers((prev) => ({
      ...prev,
      [libraryId]: (prev[libraryId] || 0) + 1,
    }));
  };

  const handleOpenResetModal = (libraryId: string, libraryName: string) => {
    setResetLibraryId(libraryId);
    setResetLibraryName(libraryName);
    setResetModalOpen(true);
  };

  const handleResetComplete = () => {
    // Refresh the library configs after reset
    setResetModalOpen(false);
  };

  const handleStopSync = async () => {
    try {
      // Cancel via the scheduled jobs system (same as Jobs settings page)
      await axios.post('/api/v1/settings/jobs/overlay-application/cancel');
      addToast('Overlay job cancelled', {
        appearance: 'success',
        autoDismiss: true,
      });
      mutateRunningLibraries();
    } catch (error) {
      addToast('Failed to stop overlay sync', {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const handleLibrarySync = async (libraryId: string, libraryName: string) => {
    const confirmKey = `sync:${libraryId}`;
    // First click - show confirmation
    if (!confirmClickedLibraries.has(confirmKey)) {
      setConfirmClickedLibraries((prev) => new Set(prev).add(confirmKey));
      // Reset after 3 seconds
      const timeout = setTimeout(() => {
        setConfirmClickedLibraries((prev) => {
          const next = new Set(prev);
          next.delete(confirmKey);
          return next;
        });
        confirmTimeoutsRef.current.delete(confirmKey);
      }, 3000);
      confirmTimeoutsRef.current.set(confirmKey, timeout);
      return;
    }

    // Second click - execute sync
    const timeout = confirmTimeoutsRef.current.get(confirmKey);
    if (timeout) {
      clearTimeout(timeout);
      confirmTimeoutsRef.current.delete(confirmKey);
    }
    setConfirmClickedLibraries((prev) => {
      const next = new Set(prev);
      next.delete(confirmKey);
      return next;
    });

    try {
      await axios.post(`/api/v1/overlay-library-configs/${libraryId}/apply`);
      addToast(
        intl.formatMessage(messages.librarySyncStarted, { libraryName }),
        {
          appearance: 'success',
          autoDismiss: true,
        }
      );
      // Status will be updated via SWR polling
    } catch (error) {
      // Handle collision errors (409 Conflict)
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        const errorMessage =
          error.response.data?.error ||
          intl.formatMessage(messages.overlaySyncError);
        addToast(errorMessage, {
          appearance: 'error',
          autoDismiss: true,
        });
      } else {
        addToast(intl.formatMessage(messages.overlaySyncError), {
          appearance: 'error',
          autoDismiss: true,
        });
      }
    }
  };

  const handleRemoveOrphanedConfig = async (
    libraryId: string,
    libraryName: string
  ) => {
    const confirmKey = `remove:${libraryId}`;
    // First click - show confirmation
    if (!confirmClickedLibraries.has(confirmKey)) {
      setConfirmClickedLibraries((prev) => new Set(prev).add(confirmKey));
      // Reset after 3 seconds
      const timeout = setTimeout(() => {
        setConfirmClickedLibraries((prev) => {
          const next = new Set(prev);
          next.delete(confirmKey);
          return next;
        });
        confirmTimeoutsRef.current.delete(confirmKey);
      }, 3000);
      confirmTimeoutsRef.current.set(confirmKey, timeout);
      return;
    }

    // Second click - execute delete
    const timeout = confirmTimeoutsRef.current.get(confirmKey);
    if (timeout) {
      clearTimeout(timeout);
      confirmTimeoutsRef.current.delete(confirmKey);
    }
    setConfirmClickedLibraries((prev) => {
      const next = new Set(prev);
      next.delete(confirmKey);
      return next;
    });

    setRemovingLibraries((prev) => new Set(prev).add(libraryId));
    try {
      await axios.delete(`/api/v1/overlay-library-configs/${libraryId}`);
      addToast(intl.formatMessage(messages.configRemoved, { libraryName }), {
        appearance: 'success',
        autoDismiss: true,
      });
      await mutate('/api/v1/overlay-library-configs');
    } catch (error) {
      // 404 means the config is already gone - same end state as a successful delete
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        addToast(intl.formatMessage(messages.configRemoved, { libraryName }), {
          appearance: 'success',
          autoDismiss: true,
        });
        await mutate('/api/v1/overlay-library-configs');
      } else {
        addToast(intl.formatMessage(messages.removeConfigError), {
          appearance: 'error',
          autoDismiss: true,
        });
      }
    } finally {
      setRemovingLibraries((prev) => {
        const next = new Set(prev);
        next.delete(libraryId);
        return next;
      });
    }
  };

  // Fetch Plex libraries - backend returns array directly
  const { data: librariesData, error: librariesError } = useSWR<PlexLibrary[]>(
    '/api/v1/settings/plex/libraries'
  );

  // Fetch library configs
  const { data: configsData } = useSWR<{ configs: LibraryConfig[] }>(
    '/api/v1/overlay-library-configs'
  );

  // Fetch overlay settings to get poster source
  const { data: overlaySettings } = useSWR<{
    defaultPosterSource: 'tmdb' | 'plex';
    initialSetupComplete: boolean;
  }>('/api/v1/overlay-settings');

  const posterSource = overlaySettings?.defaultPosterSource || 'tmdb';

  if (librariesError) {
    return (
      <div className="flex h-96 items-center justify-center">
        <div className="text-red-400">
          {intl.formatMessage(messages.failedToLoad)}
        </div>
      </div>
    );
  }

  if (!librariesData) {
    return (
      <div className="flex h-96 items-center justify-center">
        <LoadingSpinner />
        <span className="ml-3 text-stone-400">
          {intl.formatMessage(messages.loading)}
        </span>
      </div>
    );
  }

  const libraries = librariesData || [];

  if (libraries.length === 0) {
    return (
      <div className="flex h-96 items-center justify-center">
        <div className="text-stone-400">
          {intl.formatMessage(messages.noLibraries)}
        </div>
      </div>
    );
  }

  // Below libraries.length===0 guard so orphan cards can't render off an empty Plex response
  const orphanedConfigs = (configsData?.configs ?? []).filter(
    (c) => !libraries.some((l) => l.key === c.libraryId)
  );

  const getLibraryConfig = (libraryId: string): LibraryConfig | undefined => {
    return configsData?.configs.find((c) => c.libraryId === libraryId);
  };

  // Get running jobs for progress display
  const runningJobs =
    runningLibrariesData?.runningLibraries.filter((lib) => lib.running) || [];

  return (
    <div className="space-y-6">
      {/* Progress Cards for Running Jobs */}
      {runningJobs.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-stone-400">Running Jobs</h3>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {runningJobs.map((lib) => (
              <LibraryProgressCard
                key={lib.libraryId}
                status={lib}
                onStop={() => handleStopSync()}
              />
            ))}
          </div>
        </div>
      )}

      {/* Orphaned Configurations - library deleted from Plex */}
      {orphanedConfigs.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-stone-400">
            {intl.formatMessage(messages.orphanedSectionTitle)}
          </h3>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {orphanedConfigs.map((config) => {
              const isConfirmClicked = confirmClickedLibraries.has(
                `remove:${config.libraryId}`
              );
              const isRemoving = removingLibraries.has(config.libraryId);

              return (
                <div
                  key={config.libraryId}
                  className="rounded-lg bg-stone-800 opacity-60"
                >
                  <div className="p-4">
                    <h4 className="truncate text-sm font-medium text-white">
                      {config.libraryName}
                    </h4>
                    <p className="mt-1 text-xs text-stone-400">
                      {intl.formatMessage(messages.orphanedLibraryLabel)}
                    </p>

                    <div className="mt-3">
                      <Button
                        buttonType={isConfirmClicked ? 'danger' : 'ghost'}
                        buttonSize="sm"
                        className="w-full"
                        disabled={isRemoving}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveOrphanedConfig(
                            config.libraryId,
                            config.libraryName
                          );
                        }}
                      >
                        {isRemoving ? (
                          <Spinner className="h-4 w-4" />
                        ) : isConfirmClicked ? (
                          <ExclamationTriangleIcon className="h-4 w-4" />
                        ) : (
                          <TrashIcon className="h-4 w-4" />
                        )}
                        <span>
                          {isConfirmClicked
                            ? intl.formatMessage(messages.removeConfigConfirm)
                            : intl.formatMessage(messages.removeConfigLabel)}
                        </span>
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {libraries.map((library) => {
          const config = getLibraryConfig(library.key);
          const overlayCount =
            config?.enabledOverlays.filter((o) => o.enabled).length || 0;
          const hasOverlays =
            config && config.enabledOverlays.some((o) => o.enabled);
          const canFullSync =
            hasOverlays &&
            normalizeOverlaySyncTargets(config?.fullSyncTargets, library.type)
              .length > 0;
          const isSyncing = syncingLibraries.has(library.key);
          const isConfirmClicked = confirmClickedLibraries.has(
            `sync:${library.key}`
          );

          return (
            <div
              key={library.key}
              className="hover:bg-stone-750 group relative overflow-hidden rounded-lg bg-stone-800 transition-colors"
            >
              {/* Poster Preview */}
              <div className="relative aspect-[2/3] overflow-hidden bg-gradient-to-br from-stone-700 to-stone-900">
                {hasOverlays ? (
                  <LibraryPreviewLarge
                    libraryId={library.key}
                    enabledOverlays={config.enabledOverlays}
                    refreshTrigger={refreshTriggers[library.key] || 0}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <div className="text-center text-stone-500">
                      <svg
                        className="mx-auto h-16 w-16"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1}
                          d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                        />
                      </svg>
                      <p className="mt-2 text-xs">
                        {intl.formatMessage(messages.noOverlays)}
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Library Info */}
              <div className="p-4">
                <h4 className="truncate text-sm font-medium text-white">
                  {library.name}
                </h4>
                <p className="mt-1 text-xs text-stone-400">
                  {library.type === 'movie' ? 'Movies' : 'TV Shows'} •{' '}
                  {intl.formatMessage(messages.overlaysEnabled, {
                    count: overlayCount,
                  })}
                </p>

                <div className="mt-3 space-y-2">
                  {/* Top row: Configure (2/3) + Sync (1/3) */}
                  <div className="flex gap-2">
                    <Button
                      buttonType="primary"
                      buttonSize="sm"
                      className="flex-[2]"
                      onClick={() => {
                        setSelectedLibraryId(library.key);
                        setSelectedLibraryName(library.name);
                        setSelectedLibraryType(library.type);
                      }}
                    >
                      {intl.formatMessage(messages.configure)}
                    </Button>
                    {canFullSync && (
                      <Button
                        buttonType={isConfirmClicked ? 'warning' : 'ghost'}
                        buttonSize="sm"
                        className="flex-1"
                        disabled={isSyncing}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleLibrarySync(library.key, library.name);
                        }}
                      >
                        {isSyncing ? (
                          <Spinner className="h-4 w-4" />
                        ) : isConfirmClicked ? (
                          <ExclamationTriangleIcon className="h-4 w-4" />
                        ) : (
                          <PlayIcon className="h-4 w-4" />
                        )}
                        <span>
                          {isConfirmClicked
                            ? intl.formatMessage(messages.syncOverlaysConfirm)
                            : intl.formatMessage(messages.syncOverlays)}
                        </span>
                      </Button>
                    )}
                  </div>

                  {/* Bottom row: Cycle Poster + Reset Library (with text) */}
                  {hasOverlays && (
                    <div className="flex gap-2">
                      <Button
                        buttonType="ghost"
                        buttonSize="sm"
                        className="flex-1"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCyclePoster(library.key);
                        }}
                      >
                        <ArrowPathIcon className="h-4 w-4" />
                        <span>{intl.formatMessage(messages.cyclePoster)}</span>
                      </Button>
                      <Button
                        buttonType="ghost"
                        buttonSize="sm"
                        className="flex-1"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenResetModal(library.key, library.name);
                        }}
                      >
                        <ArrowUturnLeftIcon className="h-4 w-4" />
                        <span>{intl.formatMessage(messages.resetPosters)}</span>
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {selectedLibraryId && (
        <LibraryDetailConfigView
          isOpen={!!selectedLibraryId}
          onClose={() => {
            setSelectedLibraryId(null);
            setSelectedLibraryName('');
          }}
          libraryId={selectedLibraryId}
          libraryName={selectedLibraryName}
          libraryType={selectedLibraryType}
        />
      )}

      {resetModalOpen && (
        <PosterResetModal
          isOpen={resetModalOpen}
          onClose={() => setResetModalOpen(false)}
          onComplete={handleResetComplete}
          libraryId={resetLibraryId}
          libraryName={resetLibraryName}
          posterSource={posterSource}
        />
      )}
    </div>
  );
};

export default LibraryConfigView;

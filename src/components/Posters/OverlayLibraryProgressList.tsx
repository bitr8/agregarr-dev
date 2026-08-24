import type { OverlayTargetProgressMap } from '@app/components/Posters/OverlayTargetProgress';
import OverlayTargetProgress from '@app/components/Posters/OverlayTargetProgress';
import type { OverlayArtworkTarget } from '@server/lib/overlays/overlayTargets';
import type React from 'react';

export interface OverlayLibraryProgressValue {
  libraryId: string;
  libraryName: string;
  state: 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
  totalItems: number;
  currentItem: number;
  currentTitle: string;
  currentTarget?: OverlayArtworkTarget | null;
  targetProgress?: OverlayTargetProgressMap;
  successCount: number;
  errorCount: number;
  skippedCount: number;
  filteredCount: number;
}

interface OverlayLibraryProgressListProps {
  libraries: OverlayLibraryProgressValue[];
}

const stateLabel = (state: OverlayLibraryProgressValue['state']): string => {
  if (state === 'running') return 'In progress';
  if (state === 'cancelling') return 'Stopping';
  return state.charAt(0).toUpperCase() + state.slice(1);
};

const OverlayLibraryProgressList: React.FC<OverlayLibraryProgressListProps> = ({
  libraries,
}) => {
  if (libraries.length === 0) return null;

  return (
    <div className="mb-4">
      <p className="mb-2 text-xs font-medium text-gray-300">Library progress</p>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {libraries.map((library) => {
          const percent =
            library.totalItems > 0
              ? Math.min(
                  100,
                  Math.round((library.currentItem / library.totalItems) * 100)
                )
              : library.state === 'completed'
              ? 100
              : 0;
          const isActive =
            library.state === 'running' || library.state === 'cancelling';

          return (
            <div
              key={library.libraryId}
              className={`rounded-md border bg-stone-900 p-3 ${
                isActive ? 'border-orange-500' : 'border-stone-700'
              }`}
            >
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white">
                    {library.libraryName}
                  </p>
                  {isActive && library.currentTitle && (
                    <p className="truncate text-[10px] text-gray-500">
                      {library.currentTitle}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p
                    className={`text-[10px] ${
                      isActive ? 'text-orange-300' : 'text-gray-400'
                    }`}
                  >
                    {stateLabel(library.state)}
                  </p>
                  <p className="whitespace-nowrap text-xs tabular-nums text-gray-500">
                    {library.currentItem}/{library.totalItems}
                  </p>
                </div>
              </div>

              <div className="mb-3 mt-2 h-1 overflow-hidden rounded-full bg-gray-700">
                <div
                  className={`h-full transition-all duration-300 ${
                    isActive ? 'bg-orange-500' : 'bg-stone-500'
                  }`}
                  style={{ width: `${percent}%` }}
                />
              </div>

              <OverlayTargetProgress
                progress={library.targetProgress}
                currentTarget={isActive ? library.currentTarget : null}
              />

              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
                <span className="text-green-400">
                  {library.successCount} success
                </span>
                <span className="text-red-400">
                  {library.errorCount} errors
                </span>
                <span className="text-amber-400">
                  {library.skippedCount} unchanged
                </span>
                <span className="text-blue-400">
                  {library.filteredCount} filtered
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default OverlayLibraryProgressList;

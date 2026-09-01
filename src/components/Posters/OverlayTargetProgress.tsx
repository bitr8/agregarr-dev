import type { OverlayArtworkTarget } from '@server/lib/overlays/overlayTargets';
import type React from 'react';
import { defineMessages, useIntl } from 'react-intl';

export interface OverlayTargetProgressValue {
  totalItems: number;
  currentItem: number;
  successCount: number;
  errorCount: number;
  skippedCount: number;
  filteredCount: number;
}

export type OverlayTargetProgressMap = Partial<
  Record<OverlayArtworkTarget, OverlayTargetProgressValue>
>;

interface OverlayTargetProgressProps {
  progress?: OverlayTargetProgressMap;
  currentTarget?: OverlayArtworkTarget | null;
}

const messages = defineMessages({
  posters: 'Posters',
  seasons: 'Seasons',
  episodes: 'Episodes',
});

const targets: OverlayArtworkTarget[] = ['main', 'season', 'episode'];

const OverlayTargetProgress: React.FC<OverlayTargetProgressProps> = ({
  progress,
  currentTarget,
}) => {
  const intl = useIntl();
  const visibleTargets = targets.filter((target) => {
    const value = progress?.[target];
    return value && (value.totalItems > 0 || value.currentItem > 0);
  });

  if (visibleTargets.length === 0) return null;

  return (
    <div
      className="mb-4 grid gap-2"
      style={{
        gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))',
      }}
    >
      {visibleTargets.map((target) => {
        const value = progress?.[target];
        if (!value) return null;

        const label = intl.formatMessage(
          target === 'main'
            ? messages.posters
            : target === 'season'
            ? messages.seasons
            : messages.episodes
        );

        const percent =
          value.totalItems > 0
            ? Math.min(
                100,
                Math.round((value.currentItem / value.totalItems) * 100)
              )
            : 0;
        const isCurrent = currentTarget === target;

        return (
          <div
            key={target}
            className={`min-w-0 rounded-md border bg-stone-900 px-3 py-2 ${
              isCurrent ? 'border-orange-500' : 'border-stone-700'
            }`}
            title={`${label}: ${value.currentItem}/${value.totalItems}`}
          >
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <span
                className={`min-w-0 flex-1 truncate ${
                  isCurrent ? 'text-orange-300' : 'text-gray-400'
                }`}
              >
                {label}
              </span>
              <span className="shrink-0 whitespace-nowrap text-right font-medium tabular-nums text-gray-200">
                {value.currentItem}/{value.totalItems}
              </span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-gray-700">
              <div
                className={`h-full transition-all duration-300 ${
                  isCurrent ? 'bg-orange-500' : 'bg-stone-500'
                }`}
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default OverlayTargetProgress;

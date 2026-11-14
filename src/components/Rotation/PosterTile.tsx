import Tooltip from '@app/components/Common/Tooltip';
import messages from '@app/components/Rotation/messages';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

interface PosterTileProps {
  name: string | null;
  posterUrl: string | null;
  size?: 'lg' | 'sm';
  slotIndex?: number;
  animateIn?: boolean;
  delayMs?: number;
}

const PosterTile = ({
  name,
  posterUrl,
  size = 'lg',
  slotIndex,
  animateIn = false,
  delayMs = 0,
}: PosterTileProps) => {
  const intl = useIntl();
  const [failed, setFailed] = useState(false);
  const [entered, setEntered] = useState(!animateIn);

  useEffect(() => {
    if (!animateIn) {
      return;
    }
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [animateIn]);

  const isLarge = size === 'lg';
  const empty = name === null;
  const showImage = !empty && !!posterUrl && !failed;

  const box = empty
    ? 'border-2 border-dashed border-gray-700 bg-transparent'
    : 'bg-stone-700 ring-1 ring-white/10';

  return (
    <div
      className={`shrink-0 snap-start transition duration-300 ease-out motion-reduce:transform-none motion-reduce:transition-none ${
        isLarge ? 'w-28 sm:w-32 lg:w-36' : 'w-16 opacity-80 lg:w-20'
      } ${entered ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0'}`}
      style={animateIn ? { transitionDelay: `${delayMs}ms` } : undefined}
    >
      <div
        className={`relative aspect-[2/3] overflow-hidden rounded-md ${box}`}
      >
        {showImage ? (
          <img
            src={posterUrl}
            alt={name ?? ''}
            loading="lazy"
            onError={() => setFailed(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <div
            className={`flex h-full w-full items-center justify-center p-2 text-center text-xs ${
              empty
                ? 'text-gray-500'
                : 'bg-gradient-to-br from-stone-700 to-stone-800 text-gray-300'
            }`}
          >
            {empty ? intl.formatMessage(messages.emptySlot) : name}
          </div>
        )}
        {isLarge && slotIndex !== undefined && (
          <span
            className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-xs font-medium text-white"
            aria-label={intl.formatMessage(messages.slotLabel, {
              index: slotIndex,
            })}
          >
            {slotIndex}
          </span>
        )}
      </div>
      {isLarge && (
        <Tooltip content={name}>
          <p
            className={`mt-2 truncate text-sm ${
              empty ? 'text-gray-500' : 'text-gray-200'
            }`}
          >
            {name ?? intl.formatMessage(messages.emptySlotHint)}
          </p>
        </Tooltip>
      )}
      {!isLarge && name && (
        <p className="mt-1 truncate text-xs text-gray-400">{name}</p>
      )}
    </div>
  );
};

export default PosterTile;

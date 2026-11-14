import messages from '@app/components/Rotation/messages';
import PosterTile from '@app/components/Rotation/PosterTile';
import type { RotationGroupStatus } from '@server/interfaces/api/rotationInterfaces';
import { useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';

interface SlotShelfProps {
  slots: RotationGroupStatus['slots'];
  caption?: React.ReactNode;
  status?: React.ReactNode;
  animate?: boolean;
}

const SlotShelf = ({ slots, caption, status, animate }: SlotShelfProps) => {
  const intl = useIntl();
  const previous = useRef<Map<string, string> | null>(null);
  const current = new Map(
    slots.map((s) => [s.slotId, s.occupant?.key ?? 'empty'])
  );

  useEffect(() => {
    previous.current = current;
  });

  const changed = (slotId: string) =>
    !!animate &&
    previous.current !== null &&
    previous.current.has(slotId) &&
    previous.current.get(slotId) !== current.get(slotId);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h4 className="text-sm font-medium text-gray-300">
          {caption ?? intl.formatMessage(messages.showingNow)}
        </h4>
        {status}
      </div>
      <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
        {slots.map((slot, i) => (
          <PosterTile
            key={`${slot.slotId}:${slot.occupant?.key ?? 'empty'}`}
            name={slot.occupant?.name ?? null}
            posterUrl={slot.occupant?.posterUrl ?? null}
            slotIndex={slot.index + 1}
            animateIn={changed(slot.slotId)}
            delayMs={i * 40}
          />
        ))}
      </div>
    </div>
  );
};

export default SlotShelf;

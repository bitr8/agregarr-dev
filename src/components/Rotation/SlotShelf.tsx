import messages from '@app/components/Rotation/messages';
import PosterTile from '@app/components/Rotation/PosterTile';
import type { RotationGroupStatus } from '@server/interfaces/api/rotationInterfaces';
import { useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';

interface SlotShelfProps {
  slots: RotationGroupStatus['slots'];
  seq?: number;
  caption?: React.ReactNode;
}

const SlotShelf = ({ slots, seq, caption }: SlotShelfProps) => {
  const intl = useIntl();
  const seen = useRef(seq);
  const animate = seq !== undefined && seen.current !== seq;

  useEffect(() => {
    seen.current = seq;
  }, [seq]);

  return (
    <div>
      <h4 className="mb-2 text-sm font-medium text-gray-300">
        {caption ?? intl.formatMessage(messages.showingNow)}
      </h4>
      <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
        {slots.map((slot, i) => (
          <PosterTile
            key={`${slot.slotId}:${slot.occupant?.key ?? 'empty'}:${seq ?? 0}`}
            name={slot.occupant?.name ?? null}
            posterUrl={slot.occupant?.posterUrl ?? null}
            slotIndex={slot.index}
            animateIn={animate}
            delayMs={i * 40}
          />
        ))}
      </div>
    </div>
  );
};

export default SlotShelf;

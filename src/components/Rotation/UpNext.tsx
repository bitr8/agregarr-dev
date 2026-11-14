import messages from '@app/components/Rotation/messages';
import PosterThumb from '@app/components/Rotation/PosterThumb';
import PosterTile from '@app/components/Rotation/PosterTile';
import type { MemberSummary } from '@server/interfaces/api/rotationInterfaces';
import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

interface UpNextProps {
  members: MemberSummary[];
  remaining: number;
}

const Fade = ({
  animate,
  children,
}: {
  animate: boolean;
  children: React.ReactNode;
}) => {
  const [entered, setEntered] = useState(!animate);

  useEffect(() => {
    if (entered) {
      return;
    }
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={`transition-opacity duration-500 motion-reduce:transition-none ${
        entered ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {children}
    </div>
  );
};

const UpNext = ({ members, remaining }: UpNextProps) => {
  const intl = useIntl();
  const firstKey = useRef<string | null>(null);
  const batchKey = members.map((m) => m.key).join('|');
  if (firstKey.current === null) {
    firstKey.current = batchKey;
  }

  return (
    <div className="mt-5">
      <h4 className="mb-2 text-sm font-medium text-gray-300">
        {intl.formatMessage(messages.upNext)}
      </h4>
      {members.length === 0 ? (
        <p className="text-sm text-gray-500">
          {intl.formatMessage(messages.nothingWaiting)}
        </p>
      ) : (
        <Fade key={batchKey} animate={batchKey !== firstKey.current}>
          <div className="hidden gap-3 sm:flex">
            {members.map((m) => (
              <PosterTile
                key={m.key}
                name={m.name}
                posterUrl={m.posterUrl}
                size="sm"
              />
            ))}
            {remaining > 0 && (
              <span className="self-center text-sm text-gray-500">
                {intl.formatMessage(messages.thenMore, { count: remaining })}
              </span>
            )}
          </div>
          <div className="sm:hidden">
            <ul className="space-y-2">
              {members.map((m) => (
                <li key={m.key} className="flex items-center gap-3">
                  <PosterThumb name={m.name} posterUrl={m.posterUrl} />
                  <span className="truncate text-sm text-gray-200">
                    {m.name}
                  </span>
                </li>
              ))}
            </ul>
            {remaining > 0 && (
              <p className="mt-2 text-sm text-gray-500">
                {intl.formatMessage(messages.thenMore, { count: remaining })}
              </p>
            )}
          </div>
        </Fade>
      )}
    </div>
  );
};

export default UpNext;

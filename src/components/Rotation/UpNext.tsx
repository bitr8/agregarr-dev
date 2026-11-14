import messages from '@app/components/Rotation/messages';
import PosterTile from '@app/components/Rotation/PosterTile';
import type { MemberSummary } from '@server/interfaces/api/rotationInterfaces';
import { useIntl } from 'react-intl';

interface UpNextProps {
  members: MemberSummary[];
  remaining: number;
}

const UpNext = ({ members, remaining }: UpNextProps) => {
  const intl = useIntl();

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
        <>
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
                  {m.posterUrl ? (
                    <img
                      src={m.posterUrl}
                      alt={m.name}
                      loading="lazy"
                      className="h-12 w-8 rounded bg-stone-700 object-cover"
                    />
                  ) : (
                    <div className="h-12 w-8 rounded bg-stone-700" />
                  )}
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
        </>
      )}
    </div>
  );
};

export default UpNext;

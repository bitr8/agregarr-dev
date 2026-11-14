import messages from '@app/components/Rotation/messages';
import {
  formatRelative,
  nextChangeSentence,
} from '@app/components/Rotation/utils';
import type { RotationGroupStatus } from '@server/interfaces/api/rotationInterfaces';
import { useIntl } from 'react-intl';

interface NextChangeProps {
  group: RotationGroupStatus;
}

const NextChange = ({ group }: NextChangeProps) => {
  const intl = useIntl();

  return (
    <div className="order-first rounded-md bg-stone-800/60 p-4 lg:order-none">
      <h4 className="text-sm font-medium text-gray-300">
        {intl.formatMessage(messages.nextChangeTitle)}
      </h4>
      <p className="mt-1 text-sm leading-6 text-gray-200">
        {nextChangeSentence(intl, group)}
      </p>
      {group.lastRotatedAt && (
        <p className="mt-2 text-xs text-gray-500">
          {intl.formatMessage(messages.lastChanged, {
            when: formatRelative(intl, group.lastRotatedAt),
          })}
        </p>
      )}
    </div>
  );
};

export default NextChange;

import messages from '@app/components/Rotation/messages';
import {
  formatDay,
  formatRelative,
  formatWhen,
} from '@app/components/Rotation/utils';
import type { RotationGroupStatus } from '@server/interfaces/api/rotationInterfaces';
import { useIntl } from 'react-intl';

interface NextChangeProps {
  group: RotationGroupStatus;
}

const NextChange = ({ group }: NextChangeProps) => {
  const intl = useIntl();
  const { nextChange, interval } = group;
  const { notBefore, expectedSyncAt } = nextChange;

  let text: string;
  if (nextChange.kind === 'disabled') {
    text = intl.formatMessage(messages.nextDisabled);
  } else if (nextChange.kind === 'monthly_done') {
    text = intl.formatMessage(messages.nextMonthlyDone);
  } else if (nextChange.kind === 'every_sync') {
    text = expectedSyncAt
      ? intl.formatMessage(messages.nextEverySync, {
          time: formatWhen(intl, expectedSyncAt),
        })
      : intl.formatMessage(messages.nextEverySyncNoTime);
  } else if (!notBefore) {
    text = intl.formatMessage(messages.nextEverySyncNoTime);
  } else if (!expectedSyncAt) {
    text = intl.formatMessage(messages.nextNoSchedule, {
      date: formatDay(intl, notBefore),
    });
  } else if (interval === 'daily' || interval === '12h') {
    const midday = new Date(notBefore).getHours() >= 12;
    text = intl.formatMessage(
      midday ? messages.nextAfterMidday : messages.nextAfterMidnight,
      { time: formatWhen(intl, expectedSyncAt) }
    );
  } else {
    text = intl.formatMessage(messages.nextOnOrAfterDay, {
      date: formatDay(intl, notBefore),
      time: formatWhen(intl, expectedSyncAt),
    });
  }

  return (
    <div className="order-first rounded-md bg-stone-800/60 p-4 lg:order-none">
      <h4 className="text-sm font-medium text-gray-300">
        {intl.formatMessage(messages.nextChangeTitle)}
      </h4>
      <p className="mt-1 text-sm leading-6 text-gray-200">{text}</p>
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

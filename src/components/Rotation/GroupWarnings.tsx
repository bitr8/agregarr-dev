import messages from '@app/components/Rotation/messages';
import { reasonText } from '@app/components/Rotation/utils';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import type {
  RotationGroupStatus,
  RotationWarning,
} from '@server/interfaces/api/rotationInterfaces';
import { useState } from 'react';
import { useIntl } from 'react-intl';

interface GroupWarningsProps {
  group: Pick<
    RotationGroupStatus,
    'slotCount' | 'cycle' | 'warnings' | 'slots'
  >;
}

const PER_MEMBER = ['unbound', 'rebound', 'own_settings_missing'];

const WarningStrip = ({
  warning,
  group,
}: {
  warning: RotationWarning;
  group: GroupWarningsProps['group'];
}) => {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const members = warning.members ?? [];
  const first = members[0]?.name ?? '';

  let text: string;
  switch (warning.code) {
    case 'pool_not_larger_than_slots':
      text = intl.formatMessage(messages.warnPool, {
        slots: group.slotCount,
        ready: group.cycle.total,
      });
      break;
    case 'empty_slots':
      text = intl.formatMessage(messages.warnEmptySlots, {
        count: group.slots.filter((s) => !s.occupant).length,
      });
      break;
    case 'sitting_out':
      text = intl.formatMessage(messages.warnSittingOut, {
        count: members.length,
      });
      break;
    case 'unbound':
      text = intl.formatMessage(messages.warnUnbound, { name: first });
      break;
    case 'rebound':
      text = intl.formatMessage(messages.warnRebound, { name: first });
      break;
    case 'own_settings_missing':
      text = intl.formatMessage(messages.warnOwnMissing, { name: first });
      break;
    case 'sync_slower_than_interval':
      text = intl.formatMessage(messages.warnSyncSlower);
      break;
    default:
      text = intl.formatMessage(messages.warnInvalid);
  }

  const expandable = members.length > 0 && !PER_MEMBER.includes(warning.code);

  return (
    <div className="mt-4 rounded border border-orange-500/20 bg-orange-500/10 p-3 text-sm text-orange-300">
      <div className="flex items-start gap-2">
        <ExclamationTriangleIcon
          className="mt-0.5 h-4 w-4 shrink-0"
          aria-hidden="true"
        />
        <p className="min-w-0 flex-1">{text}</p>
        {expandable && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="shrink-0 rounded px-1 text-orange-200 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
          >
            {intl.formatMessage(open ? messages.hide : messages.show)}
          </button>
        )}
      </div>
      {expandable && open && (
        <ul className="mt-2 space-y-1 pl-6 text-orange-200/90">
          {members.map((m) => (
            <li key={m.key}>
              {m.name}
              {reasonText(intl, m.reason) && (
                <span className="text-orange-300/80">
                  {' '}
                  {reasonText(intl, m.reason)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const GroupWarnings = ({ group }: GroupWarningsProps) => {
  const strips = group.warnings.flatMap((warning) =>
    PER_MEMBER.includes(warning.code) && (warning.members?.length ?? 0) > 1
      ? (warning.members ?? []).map((m) => ({ ...warning, members: [m] }))
      : [warning]
  );

  return (
    <>
      {strips.map((warning, i) => (
        <WarningStrip
          key={`${warning.code}:${warning.members?.[0]?.key ?? i}`}
          warning={warning}
          group={group}
        />
      ))}
    </>
  );
};

export default GroupWarnings;

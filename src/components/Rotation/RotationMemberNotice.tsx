import RotationBadge from '@app/components/Rotation/RotationBadge';
import type { Membership } from '@server/interfaces/api/rotationInterfaces';
import type React from 'react';
import { defineMessages, useIntl } from 'react-intl';

const messages = defineMessages({
  memberNotice:
    "{group} decides when this is on Home. What you choose here is saved as this collection's own setting and applies again if it leaves the rotation.",
});

const RotationMemberNotice: React.FC<{ membership: Membership }> = ({
  membership,
}) => {
  const intl = useIntl();

  return (
    <div className="mb-4 space-y-2 rounded border border-orange-500/20 bg-orange-500/10 p-3 text-sm text-orange-200">
      <div className="flex flex-wrap items-center gap-2">
        <RotationBadge membership={membership} hideState />
      </div>
      <p>
        {intl.formatMessage(messages.memberNotice, {
          group: membership.groupName,
        })}
      </p>
    </div>
  );
};

export default RotationMemberNotice;

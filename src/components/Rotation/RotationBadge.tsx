import Badge from '@app/components/Common/Badge';
import type { Membership } from '@server/interfaces/api/rotationInterfaces';
import type React from 'react';
import { defineMessages, useIntl } from 'react-intl';

const messages = defineMessages({
  badgeInRotation: 'In rotation: {group}',
  badgeOnHome: 'On Home now',
  badgeWaiting: 'Waiting its turn',
});

interface RotationBadgeProps {
  membership: Membership;
  hideState?: boolean;
}

const RotationBadge: React.FC<RotationBadgeProps> = ({
  membership,
  hideState,
}) => {
  const intl = useIntl();

  return (
    <>
      <Badge
        badgeType="primary"
        className="!bg-opacity-60"
        href={`/rotation/edit?id=${encodeURIComponent(membership.groupId)}`}
      >
        {intl.formatMessage(messages.badgeInRotation, {
          group: membership.groupName,
        })}
      </Badge>
      {!hideState && (
        <Badge badgeType="default" className="!bg-opacity-30">
          {intl.formatMessage(
            membership.showing ? messages.badgeOnHome : messages.badgeWaiting
          )}
        </Badge>
      )}
    </>
  );
};

export default RotationBadge;

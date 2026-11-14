import { LibraryBadge } from '@app/components/Collections/Shared/CollectionBadges';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
import CycleProgress from '@app/components/Rotation/CycleProgress';
import GroupWarnings from '@app/components/Rotation/GroupWarnings';
import messages from '@app/components/Rotation/messages';
import NextChange from '@app/components/Rotation/NextChange';
import PreviewNext from '@app/components/Rotation/PreviewNext';
import SlotShelf from '@app/components/Rotation/SlotShelf';
import UpNext from '@app/components/Rotation/UpNext';
import {
  formatWhen,
  intervalLabels,
  isSyncRunningError,
  surfacePlaces,
} from '@app/components/Rotation/utils';
import { ROTATION_GROUPS_URL } from '@app/hooks/rotation/useRotationGroups';
import { apiErrorMessage } from '@app/utils/apiErrorMessage';
import { Menu, Transition } from '@headlessui/react';
import {
  ArrowPathIcon,
  EllipsisVerticalIcon,
} from '@heroicons/react/24/outline';
import type {
  GroupInput,
  RotateResult,
  RotationGroupStatus,
} from '@server/interfaces/api/rotationInterfaces';
import axios from 'axios';
import { useRouter } from 'next/router';
import { Fragment, useState } from 'react';
import { useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';

interface RotationGroupCardProps {
  group: RotationGroupStatus;
  syncRunning: boolean;
  onChanged: (updated?: RotationGroupStatus, removedId?: string) => void;
}

const RotationGroupCard = ({
  group,
  syncRunning,
  onChanged,
}: RotationGroupCardProps) => {
  const intl = useIntl();
  const router = useRouter();
  const { addToast } = useToasts();
  const [rotating, setRotating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const fail = (error: unknown, fallback: string) => {
    addToast(
      isSyncRunningError(error)
        ? intl.formatMessage(messages.syncRunning)
        : apiErrorMessage(error, fallback),
      { appearance: 'error', autoDismiss: true }
    );
  };

  const rotate = async () => {
    setRotating(true);
    try {
      const { data } = await axios.post<RotateResult>(
        `${ROTATION_GROUPS_URL}/${group.id}/rotate`
      );
      addToast(
        intl.formatMessage(
          data.rotated ? messages.rotatedToast : messages.nothingToRotate
        ),
        { appearance: data.rotated ? 'success' : 'info', autoDismiss: true }
      );
      onChanged(data.group);
    } catch (error) {
      fail(error, intl.formatMessage(messages.actionFailed));
    } finally {
      setRotating(false);
    }
  };

  const toggleEnabled = async () => {
    setBusy(true);
    try {
      const { data: full } = await axios.get<RotationGroupStatus>(
        `${ROTATION_GROUPS_URL}/${group.id}`
      );
      const input: GroupInput = {
        name: full.name,
        libraryId: full.libraryId,
        enabled: !full.enabled,
        slotCount: full.slotCount,
        interval: full.interval,
        weekday: full.weekday,
        order: full.order,
        surfaces: full.surfaces,
        members: (full.members ?? []).map((m) => ({
          kind: m.kind,
          configId: m.configId,
        })),
      };
      const { data } = await axios.put<RotationGroupStatus>(
        `${ROTATION_GROUPS_URL}/${group.id}`,
        input
      );
      addToast(
        intl.formatMessage(
          data.enabled ? messages.turnedOnToast : messages.turnedOffToast
        ),
        { appearance: 'success', autoDismiss: true }
      );
      onChanged(data);
    } catch (error) {
      fail(error, intl.formatMessage(messages.actionFailed));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await axios.delete(`${ROTATION_GROUPS_URL}/${group.id}`);
      addToast(intl.formatMessage(messages.deletedToast), {
        appearance: 'success',
        autoDismiss: true,
      });
      onChanged(undefined, group.id);
    } catch (error) {
      fail(error, intl.formatMessage(messages.actionFailed));
      setBusy(false);
    }
  };

  const lockTip = intl.formatMessage(messages.syncRunningTip);
  const withTip = (button: React.ReactElement) =>
    syncRunning ? (
      <Tooltip content={lockTip}>
        <span className="inline-flex">{button}</span>
      </Tooltip>
    ) : (
      button
    );

  const occupied = group.slots.filter((s) => s.occupant).length;
  const remaining = Math.max(
    0,
    group.cycle.total - occupied - group.upNext.length
  );
  const intervalText = intl.formatMessage(
    messages[intervalLabels[group.interval].label]
  );
  const menuItem =
    'block w-full px-4 py-2 text-left text-sm focus:outline-none disabled:opacity-50';

  return (
    <section
      aria-label={group.name}
      className={`rounded-lg border border-gray-800 bg-stone-900/60 p-4 sm:p-6 ${
        group.enabled ? '' : 'opacity-70'
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="min-w-0 flex-1 truncate text-lg font-medium text-white sm:flex-none">
          {group.name}
        </h3>
        <div className="flex items-center gap-2 sm:order-none">
          <LibraryBadge libraryName={group.libraryName} />
          <Badge badgeType="default">{intervalText}</Badge>
        </div>
        <div className="order-last grid w-full grid-cols-2 gap-2 sm:order-none sm:ml-auto sm:flex sm:w-auto sm:items-center">
          <Button
            buttonSize="sm"
            buttonType="ghost"
            aria-expanded={previewOpen}
            onClick={() => setPreviewOpen((v) => !v)}
          >
            {intl.formatMessage(messages.previewNext)}
          </Button>
          {withTip(
            <Button
              buttonSize="sm"
              disabled={syncRunning || rotating || !group.enabled}
              onClick={rotate}
            >
              <ArrowPathIcon
                className={`mr-1 h-4 w-4 ${rotating ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              {intl.formatMessage(messages.rotateNow)}
            </Button>
          )}
        </div>
        <Menu as="div" className="relative ml-auto inline-block sm:ml-0">
          <Menu.Button
            aria-label={intl.formatMessage(messages.moreActions)}
            className="rounded-md p-1.5 text-gray-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
          >
            <EllipsisVerticalIcon className="h-5 w-5" aria-hidden="true" />
          </Menu.Button>
          <Transition
            as={Fragment}
            enter="transition ease-out duration-100"
            enterFrom="opacity-0 scale-95"
            enterTo="opacity-100 scale-100"
            leave="transition ease-in duration-75"
            leaveFrom="opacity-100 scale-100"
            leaveTo="opacity-0 scale-95"
          >
            <Menu.Items className="absolute right-0 z-10 mt-2 w-56 origin-top-right rounded-md bg-gray-800 py-1 shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none">
              <Menu.Item>
                {({ active }) => (
                  <button
                    type="button"
                    disabled={syncRunning}
                    onClick={() => router.push(`/rotation/${group.id}`)}
                    className={`${menuItem} ${
                      active ? 'bg-gray-700 text-white' : 'text-gray-200'
                    }`}
                  >
                    {intl.formatMessage(messages.edit)}
                  </button>
                )}
              </Menu.Item>
              <Menu.Item>
                {({ active }) => (
                  <button
                    type="button"
                    disabled={syncRunning || busy}
                    onClick={toggleEnabled}
                    className={`${menuItem} ${
                      active ? 'bg-gray-700 text-white' : 'text-gray-200'
                    }`}
                  >
                    {intl.formatMessage(
                      group.enabled ? messages.turnOff : messages.turnOn
                    )}
                  </button>
                )}
              </Menu.Item>
              <div className="px-2 py-1">
                {confirming ? (
                  <div>
                    <p className="mb-2 text-xs text-gray-300">
                      {intl.formatMessage(messages.deleteConfirm, {
                        count: group.memberCount,
                      })}
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        buttonSize="sm"
                        onClick={() => setConfirming(false)}
                      >
                        {intl.formatMessage(messages.cancel)}
                      </Button>
                      <Button
                        buttonSize="sm"
                        buttonType="danger"
                        disabled={syncRunning || busy}
                        onClick={remove}
                      >
                        {intl.formatMessage(messages.delete)}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    buttonSize="sm"
                    buttonType="danger"
                    className="w-full"
                    disabled={syncRunning}
                    onClick={() => setConfirming(true)}
                  >
                    {intl.formatMessage(messages.delete)}
                  </Button>
                )}
              </div>
              {syncRunning && (
                <p className="px-4 pb-2 pt-1 text-xs text-gray-400">
                  {lockTip}
                </p>
              )}
            </Menu.Items>
          </Transition>
        </Menu>
      </div>

      <p className="mt-1 text-sm text-gray-400">
        {intl.formatMessage(messages.surfacesLine, {
          places: surfacePlaces(intl, group.surfaces),
        })}
      </p>

      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="relative min-w-0">
          {!group.plex.applied && (
            <span
              role="status"
              className="absolute right-0 top-0 z-10 inline-flex items-center rounded-full bg-stone-800 px-2.5 py-1 text-xs text-orange-300"
            >
              {group.plex.applying || !group.plex.expectedSyncAt ? (
                <>
                  <ArrowPathIcon
                    className="mr-1 h-3 w-3 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  {intl.formatMessage(messages.plexUpdating)}
                </>
              ) : (
                intl.formatMessage(messages.plexWaiting, {
                  time: formatWhen(intl, group.plex.expectedSyncAt),
                })
              )}
            </span>
          )}
          <SlotShelf slots={group.slots} seq={group.seq} />
          <UpNext members={group.upNext} remaining={remaining} />
        </div>
        <NextChange group={group} />
      </div>

      {group.cycle.total > 0 && (
        <CycleProgress shown={group.cycle.shown} total={group.cycle.total} />
      )}
      <GroupWarnings group={group} />
      {previewOpen && (
        <PreviewNext
          groupId={group.id}
          notBefore={group.nextChange.notBefore}
        />
      )}
    </section>
  );
};

export default RotationGroupCard;

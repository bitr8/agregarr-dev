import { LibraryBadge } from '@app/components/Collections/Shared/CollectionBadges';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import Modal from '@app/components/Common/Modal';
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
  nextChangeSentence,
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
  Candidate,
  GroupInput,
  RotateResult,
  RotationGroupStatus,
} from '@server/interfaces/api/rotationInterfaces';
import axios from 'axios';
import { useRouter } from 'next/router';
import { Fragment, useState } from 'react';
import { useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';
import { useSWRConfig } from 'swr';

interface RotationGroupCardProps {
  group: RotationGroupStatus;
  syncRunning: boolean;
  onChanged: () => void;
}

const touch = 'min-h-[40px] sm:min-h-0';

const RotationGroupCard = ({
  group,
  syncRunning,
  onChanged,
}: RotationGroupCardProps) => {
  const intl = useIntl();
  const router = useRouter();
  const { addToast } = useToasts();
  const { mutate: mutateKey } = useSWRConfig();
  const [rotating, setRotating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const refresh = () => {
    onChanged();
    mutateKey(`${ROTATION_GROUPS_URL}/${group.id}`);
  };

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
      refresh();
    } catch (error) {
      fail(error, intl.formatMessage(messages.actionFailed));
    } finally {
      setRotating(false);
    }
  };

  const toggleEnabled = async () => {
    setBusy(true);
    try {
      const [{ data: full }, { data: cands }] = await Promise.all([
        axios.get<RotationGroupStatus>(`${ROTATION_GROUPS_URL}/${group.id}`),
        axios.get<{ items: Candidate[] }>(`${ROTATION_GROUPS_URL}/candidates`, {
          params: { libraryId: group.libraryId, groupId: group.id },
        }),
      ]);
      const accepted = new Set(
        cands.items.filter((c) => c.selectable).map((c) => c.key)
      );
      const kept = (full.members ?? []).filter((m) => accepted.has(m.key));
      const dropped = (full.members ?? []).length - kept.length;
      const input: GroupInput = {
        name: full.name,
        libraryId: full.libraryId,
        enabled: !full.enabled,
        slotCount: full.slotCount,
        interval: full.interval,
        weekday: full.weekday,
        order: full.order,
        surfaces: full.surfaces,
        members: kept.map((m) => ({ kind: m.kind, configId: m.configId })),
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
      if (dropped > 0) {
        addToast(
          intl.formatMessage(messages.droppedOnToggle, { count: dropped }),
          {
            appearance: 'info',
            autoDismiss: true,
          }
        );
      }
      refresh();
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
      setConfirmOpen(false);
      onChanged();
    } catch (error) {
      setConfirmOpen(false);
      fail(error, intl.formatMessage(messages.actionFailed));
    } finally {
      setBusy(false);
    }
  };

  const lockTip = intl.formatMessage(messages.syncRunningTip);
  const rotateTip = syncRunning
    ? lockTip
    : !group.enabled
    ? intl.formatMessage(messages.rotateDisabled)
    : null;

  const occupied = group.slots.filter((s) => s.occupant).length;
  const remaining = Math.max(
    0,
    group.cycle.total - occupied - group.upNext.length
  );
  const intervalText = intl.formatMessage(
    messages[intervalLabels[group.interval].label]
  );
  const menuItem = (active: boolean) =>
    `block w-full px-4 py-2.5 text-left text-sm focus:outline-none disabled:opacity-50 ${
      active ? 'bg-gray-700 text-white' : 'text-gray-200'
    }`;

  const rotateButton = (
    <Button
      buttonSize="sm"
      className={touch}
      disabled={syncRunning || rotating || !group.enabled}
      onClick={rotate}
    >
      <ArrowPathIcon
        className={`mr-1 h-4 w-4 ${
          rotating ? 'animate-spin motion-reduce:animate-none' : ''
        }`}
        aria-hidden="true"
      />
      {intl.formatMessage(messages.rotateNow)}
    </Button>
  );

  const pill = group.plex.applied ? null : (
    <span
      role="status"
      className="inline-flex w-full items-center rounded-full bg-stone-800 px-2.5 py-1 text-xs text-orange-300 sm:w-auto"
    >
      {group.plex.applying || syncRunning ? (
        <>
          <ArrowPathIcon
            className="mr-1 h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          {intl.formatMessage(messages.plexUpdating)}
        </>
      ) : group.plex.expectedSyncAt ? (
        intl.formatMessage(messages.plexWaiting, {
          time: formatWhen(intl, group.plex.expectedSyncAt),
        })
      ) : (
        intl.formatMessage(messages.plexWaitingNoTime)
      )}
    </span>
  );

  return (
    <section
      aria-label={group.name}
      className={`rounded-lg border border-gray-800 bg-stone-900/60 p-4 sm:p-6 ${
        group.enabled ? '' : 'opacity-70'
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="order-1 min-w-0 flex-1 truncate text-lg font-medium text-white sm:flex-none">
          {group.name}
        </h3>
        <div className="order-3 flex basis-full items-center gap-2 sm:order-2 sm:basis-auto">
          <LibraryBadge libraryName={group.libraryName} />
          <Badge badgeType="default">{intervalText}</Badge>
        </div>
        <div className="order-4 grid basis-full grid-cols-2 gap-2 sm:order-3 sm:ml-auto sm:flex sm:basis-auto sm:items-center">
          <Button
            buttonSize="sm"
            buttonType="ghost"
            className={`justify-center ${touch}`}
            aria-expanded={previewOpen}
            onClick={() => setPreviewOpen((v) => !v)}
          >
            {intl.formatMessage(messages.previewNext)}
          </Button>
          {rotateTip ? (
            <Tooltip content={rotateTip}>
              <span className="inline-flex [&>button]:w-full">
                {rotateButton}
              </span>
            </Tooltip>
          ) : (
            rotateButton
          )}
        </div>
        <Menu as="div" className="relative order-2 inline-block sm:order-5">
          <Menu.Button
            aria-label={intl.formatMessage(messages.moreActions)}
            className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-md text-gray-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 sm:min-h-0 sm:min-w-0 sm:p-1.5"
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
              <Menu.Item disabled={syncRunning}>
                {({ active }) => (
                  <button
                    type="button"
                    disabled={syncRunning}
                    onClick={() =>
                      router.push(
                        `/rotation/edit?id=${encodeURIComponent(group.id)}`
                      )
                    }
                    className={menuItem(active)}
                  >
                    {intl.formatMessage(messages.edit)}
                  </button>
                )}
              </Menu.Item>
              <Menu.Item disabled={syncRunning || busy}>
                {({ active }) => (
                  <button
                    type="button"
                    disabled={syncRunning || busy}
                    onClick={toggleEnabled}
                    className={menuItem(active)}
                  >
                    {intl.formatMessage(
                      group.enabled ? messages.turnOff : messages.turnOn
                    )}
                  </button>
                )}
              </Menu.Item>
              <Menu.Item disabled={syncRunning || busy}>
                {({ active }) => (
                  <button
                    type="button"
                    disabled={syncRunning || busy}
                    onClick={() => setConfirmOpen(true)}
                    className={`${menuItem(active)} !text-red-300`}
                  >
                    {intl.formatMessage(messages.delete)}
                  </button>
                )}
              </Menu.Item>
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
        <div className="min-w-0">
          <SlotShelf slots={group.slots} status={pill} animate />
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
          seq={group.seq}
          nextSentence={nextChangeSentence(intl, group)}
        />
      )}

      {confirmOpen && (
        <Modal
          title={intl.formatMessage(messages.deleteTitle)}
          okText={intl.formatMessage(messages.delete)}
          okButtonType="danger"
          okDisabled={busy}
          cancelText={intl.formatMessage(messages.cancel)}
          onOk={remove}
          onCancel={() => setConfirmOpen(false)}
          customMaxWidth="sm:max-w-md"
        >
          <p className="text-sm text-gray-300">
            {intl.formatMessage(messages.deleteConfirm, {
              count: group.memberCount,
            })}
          </p>
        </Modal>
      )}
    </section>
  );
};

export default RotationGroupCard;

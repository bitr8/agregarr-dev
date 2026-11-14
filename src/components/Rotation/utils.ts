import messages from '@app/components/Rotation/messages';
import type {
  GroupInput,
  MemberSummary,
  RotationGroupStatus,
  RotationInterval,
  Visibility,
} from '@server/interfaces/api/rotationInterfaces';
import axios from 'axios';
import type { IntlShape } from 'react-intl';

export const intervalLabels: Record<
  RotationInterval,
  { label: keyof typeof messages; help: keyof typeof messages }
> = {
  every_sync: { label: 'intervalEverySync', help: 'intervalEverySyncHelp' },
  '12h': { label: 'interval12h', help: 'interval12hHelp' },
  daily: { label: 'intervalDaily', help: 'intervalDailyHelp' },
  weekly: { label: 'intervalWeekly', help: 'intervalWeeklyHelp' },
  monthly_random: { label: 'intervalMonthly', help: 'intervalMonthlyHelp' },
};

export const draftProblem = (
  draft: GroupInput
): 'name' | 'library' | 'surface' | 'members' | null => {
  if (draft.name.trim().length === 0) return 'name';
  if (!draft.libraryId) return 'library';
  const s = draft.surfaces;
  if (!s.usersHome && !s.serverOwnerHome && !s.libraryRecommended) {
    return 'surface';
  }
  if (draft.members.length === 0) return 'members';
  return null;
};

export const isSyncRunningError = (error: unknown): boolean =>
  axios.isAxiosError(error) &&
  error.response?.status === 409 &&
  error.response.data?.code === 'SYNC_RUNNING';

export const surfacePlaces = (intl: IntlShape, surfaces: Visibility) => {
  const places: string[] = [];
  if (surfaces.usersHome) {
    places.push(intl.formatMessage(messages.usersHome));
  }
  if (surfaces.serverOwnerHome) {
    places.push(intl.formatMessage(messages.serverOwnerHome));
  }
  if (surfaces.libraryRecommended) {
    places.push(intl.formatMessage(messages.libraryRecommended));
  }
  return intl.formatList(places, { type: 'conjunction' });
};

export const formatDay = (intl: IntlShape, iso: string) =>
  intl.formatDate(iso, { weekday: 'short', day: 'numeric', month: 'short' });

export const formatWhen = (intl: IntlShape, iso: string) =>
  `${intl.formatTime(iso, {
    hour: '2-digit',
    minute: '2-digit',
  })}, ${formatDay(intl, iso)}`;

export const formatRelative = (intl: IntlShape, iso: string) => {
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  const abs = Math.abs(minutes);
  if (abs < 60) {
    return intl.formatRelativeTime(minutes, 'minute', { numeric: 'auto' });
  }
  if (abs < 60 * 48) {
    return intl.formatRelativeTime(Math.round(minutes / 60), 'hour');
  }
  return intl.formatRelativeTime(Math.round(minutes / 1440), 'day');
};

export const weekdayName = (intl: IntlShape, weekday: number) =>
  intl.formatDate(new Date(2024, 0, 7 + weekday), { weekday: 'long' });

export const reasonText = (
  intl: IntlShape,
  reason?: MemberSummary['reason']
): string | null => {
  switch (reason) {
    case 'outside_schedule':
      return intl.formatMessage(messages.reasonOutsideSchedule);
    case 'not_in_plex':
      return intl.formatMessage(messages.reasonNotInPlex);
    case 'kind_not_allowed':
      return intl.formatMessage(messages.reasonKindNotAllowed);
    case 'unbound':
      return intl.formatMessage(messages.reasonUnbound);
    default:
      return null;
  }
};

export const nextChangeSentence = (
  intl: IntlShape,
  group: Pick<
    RotationGroupStatus,
    'nextChange' | 'interval' | 'warnings' | 'enabled'
  >
): string => {
  const { nextChange, interval } = group;
  const { notBefore, expectedSyncAt } = nextChange;

  if (nextChange.kind === 'disabled') {
    return intl.formatMessage(messages.nextDisabled);
  }
  if (group.warnings.some((w) => w.code === 'pool_not_larger_than_slots')) {
    return intl.formatMessage(messages.nextNoChange);
  }
  if (nextChange.kind === 'monthly_done') {
    return intl.formatMessage(messages.nextMonthlyDone);
  }
  if (nextChange.kind === 'every_sync') {
    return expectedSyncAt
      ? intl.formatMessage(messages.nextEverySync, {
          time: formatWhen(intl, expectedSyncAt),
        })
      : intl.formatMessage(messages.nextEverySyncNoTime);
  }
  if (!notBefore) {
    return intl.formatMessage(messages.nextUnknown);
  }
  if (!expectedSyncAt) {
    return intl.formatMessage(messages.nextNoSchedule, {
      date: formatDay(intl, notBefore),
    });
  }
  if (interval === 'daily' || interval === '12h') {
    const midday = new Date(notBefore).getHours() >= 12;
    return intl.formatMessage(
      midday ? messages.nextAfterMidday : messages.nextAfterMidnight,
      { time: formatWhen(intl, expectedSyncAt) }
    );
  }
  return intl.formatMessage(messages.nextOnOrAfterDay, {
    date: formatDay(intl, notBefore),
    time: formatWhen(intl, expectedSyncAt),
  });
};

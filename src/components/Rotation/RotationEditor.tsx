import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import PageTitle from '@app/components/Common/PageTitle';
import SlideCheckbox from '@app/components/Common/SlideCheckbox';
import Tooltip from '@app/components/Common/Tooltip';
import IntervalField from '@app/components/Rotation/IntervalField';
import MemberPicker from '@app/components/Rotation/MemberPicker';
import messages from '@app/components/Rotation/messages';
import PreviewPanel from '@app/components/Rotation/PreviewPanel';
import SlotCountField from '@app/components/Rotation/SlotCountField';
import useSyncRunning from '@app/components/Rotation/useSyncRunning';
import { isSyncRunningError } from '@app/components/Rotation/utils';
import { ROTATION_GROUPS_URL } from '@app/hooks/rotation/useRotationGroups';
import { apiErrorMessage } from '@app/utils/apiErrorMessage';
import { ChevronLeftIcon, LockClosedIcon } from '@heroicons/react/24/outline';
import type {
  Candidate,
  GroupInput,
  PreviewResult,
  RotationGroupStatus,
  RotationInterval,
  Visibility,
} from '@server/interfaces/api/rotationInterfaces';
import axios from 'axios';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';
import useSWR, { useSWRConfig } from 'swr';

interface RotationEditorProps {
  groupId?: string;
}

interface PlexLibrary {
  key: string;
  name: string;
}

const SURFACES: { field: keyof Visibility; label: keyof typeof messages }[] = [
  { field: 'usersHome', label: 'usersHome' },
  { field: 'serverOwnerHome', label: 'serverOwnerHome' },
  { field: 'libraryRecommended', label: 'libraryRecommended' },
];

const RotationEditor = ({ groupId }: RotationEditorProps) => {
  const intl = useIntl();
  const router = useRouter();
  const { addToast } = useToasts();
  const { mutate: mutateGlobal } = useSWRConfig();
  const syncRunning = useSyncRunning();
  const isEdit = !!groupId;

  const { data: libraries, error: librariesError } = useSWR<PlexLibrary[]>(
    '/api/v1/settings/plex/libraries'
  );
  const {
    data: group,
    error: groupError,
    mutate: mutateGroup,
  } = useSWR<RotationGroupStatus>(
    groupId ? `${ROTATION_GROUPS_URL}/${groupId}` : null
  );

  const [name, setName] = useState('');
  const [libraryChoice, setLibraryChoice] = useState('');
  const [slotCount, setSlotCount] = useState(5);
  const [interval, setIntervalValue] = useState<RotationInterval>('daily');
  const [weekday, setWeekday] = useState(1);
  const [order, setOrder] = useState<'sequential' | 'shuffled'>('sequential');
  const [surfaces, setSurfaces] = useState<Visibility>({
    usersHome: true,
    serverOwnerHome: true,
    libraryRecommended: false,
  });
  const [enabled, setEnabled] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewSeen, setPreviewSeen] = useState(false);
  const [working, setWorking] = useState<'preview' | 'save' | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [triedSave, setTriedSave] = useState(false);
  const hydrated = useRef(false);

  useEffect(() => {
    if (group && !hydrated.current) {
      hydrated.current = true;
      setName(group.name);
      setSlotCount(group.slotCount);
      setIntervalValue(group.interval);
      setWeekday(group.weekday ?? 1);
      setOrder(group.order);
      setSurfaces(group.surfaces);
      setEnabled(group.enabled);
      setSelected(new Set((group.members ?? []).map((m) => m.key)));
    }
  }, [group]);

  const libraryId = isEdit
    ? group?.libraryId ?? ''
    : libraryChoice || libraries?.[0]?.key || '';
  const libraryName =
    group?.libraryName ??
    libraries?.find((l) => l.key === libraryId)?.name ??
    '';

  const {
    data: candidateData,
    error: candidatesError,
    mutate: mutateCandidates,
  } = useSWR<{ items: Candidate[] }>(
    libraryId
      ? `${ROTATION_GROUPS_URL}/candidates?libraryId=${encodeURIComponent(
          libraryId
        )}${group ? `&groupId=${encodeURIComponent(group.id)}` : ''}`
      : null,
    { revalidateOnFocus: false }
  );
  const candidates = candidateData?.items;

  const saved = useMemo(
    () => new Map((group?.members ?? []).map((m) => [m.key, m])),
    [group]
  );

  const draft = useMemo<GroupInput>(() => {
    const ordered = (candidates ?? [])
      .filter((c) => selected.has(c.key))
      .map((c) => ({ kind: c.kind, configId: c.configId }));
    const known = new Set((candidates ?? []).map((c) => c.key));
    const extra = Array.from(selected)
      .filter((key) => !known.has(key))
      .map((key) => {
        const at = key.indexOf(':');
        return {
          kind: key.slice(0, at) as Candidate['kind'],
          configId: key.slice(at + 1),
        };
      });
    return {
      name: name.trim(),
      libraryId,
      enabled,
      slotCount,
      interval,
      weekday: interval === 'weekly' ? weekday : undefined,
      order,
      surfaces,
      members: [...ordered, ...extra],
    };
  }, [
    candidates,
    selected,
    name,
    libraryId,
    enabled,
    slotCount,
    interval,
    weekday,
    order,
    surfaces,
  ]);

  const draftKey = JSON.stringify(draft);
  useEffect(() => {
    setPreview(null);
    setPreviewSeen(false);
  }, [draftKey]);

  const noSurface =
    !surfaces.usersHome &&
    !surfaces.serverOwnerHome &&
    !surfaces.libraryRecommended;
  const nameMissing = name.trim().length === 0;
  const count = draft.members.length;
  const rotations = Math.ceil(count / slotCount);

  const summary = (() => {
    const intervalText = intl.formatMessage(
      {
        every_sync: messages.summaryEverySync,
        '12h': messages.summary12h,
        daily: messages.summaryDaily,
        weekly: messages.summaryWeekly,
        monthly_random: messages.summaryMonthly,
      }[interval]
    );
    const turn =
      interval === 'every_sync'
        ? intl.formatMessage(messages.turnSyncs, { count: rotations })
        : interval === '12h'
        ? intl.formatMessage(messages.turnDays, {
            count: Math.ceil(rotations / 2),
          })
        : interval === 'daily'
        ? intl.formatMessage(messages.turnDays, { count: rotations })
        : interval === 'weekly'
        ? intl.formatMessage(messages.turnWeeks, { count: rotations })
        : intl.formatMessage(messages.turnMonths, { count: rotations });
    return intl.formatMessage(messages.summary, {
      slots: slotCount,
      count,
      interval: intervalText,
      turn,
    });
  })();

  const handleError = (error: unknown, fallback: string) => {
    setFormError(
      isSyncRunningError(error)
        ? intl.formatMessage(messages.syncRunning)
        : apiErrorMessage(error, fallback)
    );
  };

  const fetchPreview = async (): Promise<PreviewResult | null> => {
    try {
      const { data } = await axios.post<PreviewResult>(
        `${ROTATION_GROUPS_URL}/preview`,
        { ...draft, id: groupId }
      );
      return data;
    } catch (error) {
      handleError(error, intl.formatMessage(messages.previewError));
      return null;
    }
  };

  const openPreview = async () => {
    setFormError(null);
    setWorking('preview');
    const result = await fetchPreview();
    setWorking(null);
    if (result) {
      setPreview(result);
      setPreviewSeen(true);
    }
  };

  const save = async () => {
    setTriedSave(true);
    setFormError(null);
    if (nameMissing || noSurface || !libraryId) {
      return;
    }
    setWorking('save');
    try {
      if (!previewSeen && count > 0) {
        const result = await fetchPreview();
        if (!result) {
          return;
        }
        if (result.leavingHome.length + result.restored.length > 0) {
          setPreview(result);
          setPreviewSeen(true);
          return;
        }
      }
      if (isEdit) {
        await axios.put(`${ROTATION_GROUPS_URL}/${groupId}`, draft);
      } else {
        await axios.post(ROTATION_GROUPS_URL, draft);
      }
      addToast(intl.formatMessage(messages.savedToast), {
        appearance: 'success',
        autoDismiss: true,
      });
      mutateGlobal(ROTATION_GROUPS_URL);
      router.push('/rotation');
    } catch (error) {
      handleError(error, intl.formatMessage(messages.saveFailed));
    } finally {
      setWorking(null);
    }
  };

  const showNext = async (key: string) => {
    try {
      await axios.post(`${ROTATION_GROUPS_URL}/${groupId}/queue`, {
        moveToFront: key,
      });
      addToast(intl.formatMessage(messages.showNextDone), {
        appearance: 'success',
        autoDismiss: true,
      });
      mutateGroup();
    } catch (error) {
      addToast(
        isSyncRunningError(error)
          ? intl.formatMessage(messages.syncRunning)
          : apiErrorMessage(error, intl.formatMessage(messages.actionFailed)),
        { appearance: 'error', autoDismiss: true }
      );
    }
  };

  const lookInPlex = async () => {
    setLooking(true);
    try {
      await axios.get('/api/v1/settings/plex/library', {
        params: { sync: true },
      });
      await axios.get('/api/v1/discovery/hubs/scan');
      await mutateCandidates();
    } catch (error) {
      addToast(
        apiErrorMessage(error, intl.formatMessage(messages.candidatesError)),
        { appearance: 'error', autoDismiss: true }
      );
    } finally {
      setLooking(false);
    }
  };

  const title = isEdit
    ? group?.name ?? ''
    : intl.formatMessage(messages.editorNewTitle);

  const back = (
    <Link href="/rotation" legacyBehavior>
      <a className="mb-3 inline-flex items-center text-sm text-gray-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400">
        <ChevronLeftIcon className="mr-1 h-4 w-4" aria-hidden="true" />
        {intl.formatMessage(messages.backToRotations)}
      </a>
    </Link>
  );

  if (isEdit && groupError && !group) {
    return (
      <>
        {back}
        <Alert
          type="error"
          title={intl.formatMessage(messages.groupLoadError)}
        />
        <Button onClick={() => mutateGroup()}>
          {intl.formatMessage(messages.tryAgain)}
        </Button>
      </>
    );
  }

  if ((isEdit && !group) || (!isEdit && !libraries && !librariesError)) {
    return (
      <>
        {back}
        <div
          className="animate-pulse space-y-4"
          role="status"
          aria-label={intl.formatMessage(messages.loadingLabel)}
        >
          <div className="h-7 w-48 rounded bg-stone-700" />
          <div className="h-64 rounded-lg bg-stone-900/60" />
        </div>
      </>
    );
  }

  const saveLabel =
    previewSeen && preview && preview.leavingHome.length > 0
      ? messages.saveAndStart
      : messages.save;

  const saveButton = (
    <Button
      buttonType="primary"
      disabled={working !== null || syncRunning}
      onClick={save}
    >
      {intl.formatMessage(saveLabel)}
    </Button>
  );

  const radioCard = (selectedNow: boolean) =>
    `rounded-md border p-3 text-left text-sm font-medium text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 ${
      selectedNow
        ? 'border-orange-500 bg-orange-500/10'
        : 'border-gray-700 hover:border-gray-500'
    }`;

  return (
    <>
      <PageTitle title={[title, intl.formatMessage(messages.pageTitle)]} />
      {back}
      <h3 className="heading mb-6 text-white">{title}</h3>

      {formError && <Alert type="error">{formError}</Alert>}

      <div className="lg:grid lg:grid-cols-[22rem_minmax(0,1fr)] lg:gap-8">
        <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          <div className="form-row">
            <label htmlFor="rotation-name" className="text-label">
              {intl.formatMessage(messages.fieldName)}
            </label>
            <input
              id="rotation-name"
              type="text"
              value={name}
              maxLength={60}
              placeholder={intl.formatMessage(messages.namePlaceholder)}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={triedSave && nameMissing}
            />
            {triedSave && nameMissing && (
              <p className="mt-1 text-xs text-red-400">
                {intl.formatMessage(messages.nameRequired)}
              </p>
            )}
          </div>

          <div className="form-row">
            <label htmlFor="rotation-library" className="text-label">
              {intl.formatMessage(messages.fieldLibrary)}
            </label>
            {isEdit ? (
              <p className="flex items-center text-sm text-gray-200">
                <LockClosedIcon
                  className="mr-2 h-4 w-4 text-gray-500"
                  aria-hidden="true"
                />
                {libraryName}
              </p>
            ) : (
              <select
                id="rotation-library"
                value={libraryId}
                onChange={(e) => {
                  setLibraryChoice(e.target.value);
                  setSelected(new Set());
                }}
              >
                {(libraries ?? []).map((l) => (
                  <option key={l.key} value={l.key}>
                    {l.name}
                  </option>
                ))}
              </select>
            )}
            <p className="label-tip">
              {intl.formatMessage(messages.libraryLockedTip)}
            </p>
          </div>

          <div className="form-row">
            <span className="text-label">
              {intl.formatMessage(messages.fieldSlots)}
            </span>
            <SlotCountField value={slotCount} onChange={setSlotCount} />
          </div>

          <div className="form-row">
            <span className="text-label">
              {intl.formatMessage(messages.fieldChange)}
            </span>
            <IntervalField
              interval={interval}
              weekday={weekday}
              onChange={setIntervalValue}
              onWeekdayChange={setWeekday}
            />
          </div>

          <div className="form-row">
            <span className="text-label">
              {intl.formatMessage(messages.fieldOrder)}
            </span>
            <div
              role="radiogroup"
              aria-label={intl.formatMessage(messages.fieldOrder)}
              className="grid gap-2"
            >
              {(
                [
                  ['sequential', messages.orderSequential],
                  ['shuffled', messages.orderShuffled],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={order === value}
                  onClick={() => setOrder(value)}
                  className={radioCard(order === value)}
                >
                  {intl.formatMessage(label)}
                </button>
              ))}
            </div>
          </div>

          <fieldset className="form-row">
            <legend className="text-label">
              {intl.formatMessage(messages.fieldSurfaces)}
            </legend>
            <div className="space-y-2">
              {SURFACES.map(({ field, label }) => (
                <div key={field} className="flex items-center">
                  <input
                    type="checkbox"
                    id={`rotation-surface-${field}`}
                    className="form-checkbox"
                    checked={surfaces[field]}
                    onChange={(e) =>
                      setSurfaces({ ...surfaces, [field]: e.target.checked })
                    }
                  />
                  <label
                    htmlFor={`rotation-surface-${field}`}
                    className="mb-0 ml-2 text-sm font-normal text-gray-300"
                  >
                    {intl.formatMessage(messages[label])}
                  </label>
                </div>
              ))}
            </div>
            {noSurface && (
              <p className="mt-1 text-xs text-red-400">
                {intl.formatMessage(messages.surfacesRequired)}
              </p>
            )}
          </fieldset>

          <div className="form-row">
            <div className="flex items-center gap-3">
              <SlideCheckbox
                checked={enabled}
                onClick={() => setEnabled((v) => !v)}
              />
              <span className="text-sm text-gray-200">
                {intl.formatMessage(messages.fieldEnabled)}
              </span>
            </div>
            {!enabled && (
              <p className="label-tip">
                {intl.formatMessage(messages.disabledTip)}
              </p>
            )}
          </div>
        </div>

        <div className="mt-8 min-w-0 lg:mt-0">
          <MemberPicker
            candidates={candidates}
            error={candidatesError}
            loading={!candidateData && !candidatesError}
            onRetry={() => mutateCandidates()}
            libraryId={libraryId}
            libraryName={libraryName}
            selected={selected}
            onSelectedChange={setSelected}
            saved={saved}
            onShowNext={showNext}
            actionsLocked={syncRunning}
            lockTip={intl.formatMessage(messages.syncRunningTip)}
            onLookInPlex={lookInPlex}
            looking={looking}
          />
        </div>
      </div>

      <div
        className="sticky bottom-0 -mx-4 mt-8 border-t border-gray-800 bg-stone-900/95 px-4 pt-3 backdrop-blur"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        {preview && (
          <PreviewPanel preview={preview} onClose={() => setPreview(null)} />
        )}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-gray-300">
            {count > 0 && count <= slotCount && (
              <p className="mb-1 text-orange-300">
                {intl.formatMessage(messages.warnPool, {
                  slots: slotCount,
                  ready: count,
                })}
              </p>
            )}
            <p>{summary}</p>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:flex sm:shrink-0">
            <Button buttonType="ghost" onClick={() => router.push('/rotation')}>
              {intl.formatMessage(messages.cancel)}
            </Button>
            <Button
              disabled={working !== null || count === 0}
              onClick={openPreview}
            >
              {intl.formatMessage(messages.preview)}
            </Button>
            {syncRunning ? (
              <Tooltip content={intl.formatMessage(messages.syncRunningTip)}>
                <span className="inline-flex">{saveButton}</span>
              </Tooltip>
            ) : (
              saveButton
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default RotationEditor;

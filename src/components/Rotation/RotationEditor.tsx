import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import PageTitle from '@app/components/Common/PageTitle';
import SlideCheckbox from '@app/components/Common/SlideCheckbox';
import Tooltip from '@app/components/Common/Tooltip';
import IntervalField from '@app/components/Rotation/IntervalField';
import type { RowCandidate } from '@app/components/Rotation/MemberPicker';
import MemberPicker from '@app/components/Rotation/MemberPicker';
import messages from '@app/components/Rotation/messages';
import PreviewPanel from '@app/components/Rotation/PreviewPanel';
import RadioCards from '@app/components/Rotation/RadioCards';
import SlotCountField from '@app/components/Rotation/SlotCountField';
import useSyncRunning from '@app/components/Rotation/useSyncRunning';
import {
  intervalLabels,
  isSyncRunningError,
  nextChangeSentence,
} from '@app/components/Rotation/utils';
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

  const {
    data: libraries,
    error: librariesError,
    mutate: mutateLibraries,
  } = useSWR<PlexLibrary[]>('/api/v1/settings/plex/libraries');
  const {
    data: group,
    error: groupError,
    mutate: mutateGroup,
    isValidating: groupValidating,
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
  const [lookResult, setLookResult] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const hydrated = useRef(false);

  useEffect(() => {
    hydrated.current = false;
  }, [groupId]);

  useEffect(() => {
    if (group && !groupValidating && !hydrated.current) {
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
  }, [group, groupValidating]);

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
  const serverCandidates = candidateData?.items;

  const candidates = useMemo<RowCandidate[] | undefined>(() => {
    if (!serverCandidates) {
      return undefined;
    }
    const known = new Set(serverCandidates.map((c) => c.key));
    const missing: RowCandidate[] = (group?.members ?? [])
      .filter((m) => !known.has(m.key))
      .map((m) => ({
        key: m.key,
        kind: m.kind,
        configId: m.configId,
        name: m.name,
        libraryId: group?.libraryId ?? '',
        libraryName: group?.libraryName ?? '',
        type: '',
        posterUrl: m.posterUrl,
        selectable: false,
        missing: true,
      }));
    return [...missing, ...serverCandidates];
  }, [serverCandidates, group]);

  const saved = useMemo(
    () => new Map((group?.members ?? []).map((m) => [m.key, m])),
    [group]
  );

  const excluded = useMemo(
    () =>
      new Set(
        (candidates ?? [])
          .filter((c) => selected.has(c.key) && !c.selectable)
          .map((c) => c.key)
      ),
    [candidates, selected]
  );

  const draft = useMemo<GroupInput>(() => {
    const ordered = (candidates ?? [])
      .filter((c) => selected.has(c.key) && c.selectable)
      .map((c) => ({ kind: c.kind, configId: c.configId }));
    return {
      name: name.trim(),
      libraryId,
      enabled,
      slotCount,
      interval,
      weekday: interval === 'weekly' ? weekday : undefined,
      order,
      surfaces,
      members: ordered,
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
    if (count === 0 || count <= slotCount) {
      return intl.formatMessage(messages.summaryShort, {
        slots: slotCount,
        count,
        interval: intervalText,
      });
    }
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
      requestAnimationFrame(() =>
        previewRef.current?.scrollIntoView({ block: 'nearest' })
      );
    }
  };

  const focusField = (id: string) => {
    const el = document.getElementById(id);
    el?.scrollIntoView({ block: 'center' });
    el?.focus({ preventScroll: true });
  };

  const save = async () => {
    setTriedSave(true);
    setFormError(null);
    if (nameMissing) {
      focusField('rotation-name');
      return;
    }
    if (!libraryId) {
      setFormError(intl.formatMessage(messages.libraryRequired));
      focusField('rotation-library');
      return;
    }
    if (noSurface) {
      focusField('rotation-surface-usersHome');
      return;
    }
    if (count === 0) {
      setFormError(intl.formatMessage(messages.membersRequired));
      focusField('rotation-member-search');
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
      if (groupId) {
        mutateGlobal(`${ROTATION_GROUPS_URL}/${groupId}`);
      }
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
    setLookResult(null);
    try {
      await axios.get('/api/v1/settings/plex/library', {
        params: { sync: true },
      });
      await axios.get('/api/v1/discovery/hubs/scan');
      const after = await mutateCandidates();
      const added =
        (after?.items.length ?? 0) - (serverCandidates?.length ?? 0);
      setLookResult(
        added > 0
          ? intl.formatMessage(messages.foundNew, { count: added })
          : intl.formatMessage(messages.foundNone)
      );
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

  if (!isEdit && librariesError && !libraries) {
    return (
      <>
        {back}
        <Alert
          type="error"
          title={intl.formatMessage(messages.librariesError)}
        />
        <Button onClick={() => mutateLibraries()}>
          {intl.formatMessage(messages.tryAgain)}
        </Button>
      </>
    );
  }

  if ((isEdit && (!group || !hydrated.current)) || (!isEdit && !libraries)) {
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
      className="w-full justify-center sm:w-auto"
      disabled={working !== null || syncRunning}
      onClick={save}
    >
      {intl.formatMessage(saveLabel)}
    </Button>
  );

  const nextSentence =
    group && group.interval === interval
      ? nextChangeSentence(intl, group)
      : intl.formatMessage(messages[intervalLabels[interval].help]);

  return (
    <>
      <PageTitle title={[title, intl.formatMessage(messages.pageTitle)]} />
      {back}
      <h3 className="heading mb-6 text-white">{title}</h3>

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
            <RadioCards
              ariaLabel={intl.formatMessage(messages.fieldOrder)}
              value={order}
              onChange={setOrder}
              options={[
                {
                  value: 'sequential',
                  label: intl.formatMessage(messages.orderSequential),
                },
                {
                  value: 'shuffled',
                  label: intl.formatMessage(messages.orderShuffled),
                },
              ]}
            />
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
            <div
              role="group"
              aria-labelledby="rotation-enabled-label"
              className="flex items-center gap-3"
            >
              <SlideCheckbox
                checked={enabled}
                onClick={() => setEnabled((v) => !v)}
              />
              <span
                id="rotation-enabled-label"
                className="text-sm text-gray-200"
              >
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
            excluded={excluded}
            lookResult={lookResult}
            onLookInPlex={lookInPlex}
            looking={looking}
          />
        </div>
      </div>

      {preview && (
        <div ref={previewRef} className="mt-8">
          <PreviewPanel
            preview={preview}
            caption={nextSentence}
            onClose={() => setPreview(null)}
          />
        </div>
      )}

      <div
        className="sticky bottom-0 z-10 -mx-4 mt-6 border-t border-gray-800 bg-stone-900/95 px-4 pt-3 backdrop-blur"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        {formError && (
          <p role="alert" className="mb-2 text-sm text-red-400">
            {formError}
          </p>
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
          <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
            <Button
              buttonType="ghost"
              className="justify-center"
              onClick={() => router.push('/rotation')}
            >
              {intl.formatMessage(messages.cancel)}
            </Button>
            <Button
              className="justify-center"
              disabled={working !== null || count === 0}
              onClick={openPreview}
            >
              {intl.formatMessage(messages.preview)}
            </Button>
            <div className="col-span-2 sm:col-span-1">
              {syncRunning ? (
                <Tooltip content={intl.formatMessage(messages.syncRunningTip)}>
                  <span className="flex">{saveButton}</span>
                </Tooltip>
              ) : (
                saveButton
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default RotationEditor;

import {
  getTypeLabel,
  PreExistingBadge,
  SourceSubtypeBadge,
} from '@app/components/Collections/Shared/CollectionBadges';
import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import messages from '@app/components/Rotation/messages';
import { reasonText } from '@app/components/Rotation/utils';
import {
  LockClosedIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
import type {
  Candidate,
  MemberSummary,
} from '@server/interfaces/api/rotationInterfaces';
import { useMemo, useState } from 'react';
import { useIntl } from 'react-intl';

interface MemberPickerProps {
  candidates?: Candidate[];
  error?: unknown;
  loading: boolean;
  onRetry: () => void;
  libraryId: string;
  libraryName: string;
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  saved: Map<string, MemberSummary>;
  onShowNext: (key: string) => void;
  actionsLocked: boolean;
  lockTip: string;
  onLookInPlex: () => void;
  looking: boolean;
}

const MemberPicker = ({
  candidates,
  error,
  loading,
  onRetry,
  libraryId,
  libraryName,
  selected,
  onSelectedChange,
  saved,
  onShowNext,
  actionsLocked,
  lockTip,
  onLookInPlex,
  looking,
}: MemberPickerProps) => {
  const intl = useIntl();
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [allLibraries, setAllLibraries] = useState(false);
  const [selectedOnly, setSelectedOnly] = useState(false);

  const typeOptions = useMemo(
    () =>
      Array.from(
        new Set(
          (candidates ?? [])
            .filter((c) => c.kind === 'collection')
            .map((c) => c.type)
        )
      ),
    [candidates]
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (candidates ?? []).filter((c) => {
      if (!allLibraries && c.libraryId !== libraryId) {
        return false;
      }
      if (q && !c.name.toLowerCase().includes(q)) {
        return false;
      }
      if (typeFilter === 'preExisting' && c.kind !== 'preExisting') {
        return false;
      }
      if (
        typeFilter !== 'all' &&
        typeFilter !== 'preExisting' &&
        (c.kind !== 'collection' || c.type !== typeFilter)
      ) {
        return false;
      }
      if (selectedOnly && !selected.has(c.key)) {
        return false;
      }
      return true;
    });
  }, [
    candidates,
    query,
    typeFilter,
    allLibraries,
    libraryId,
    selectedOnly,
    selected,
  ]);

  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    onSelectedChange(next);
  };

  const selectShown = () => {
    const next = new Set(selected);
    shown.filter((c) => c.selectable).forEach((c) => next.add(c.key));
    onSelectedChange(next);
  };

  const clearShown = () => {
    const next = new Set(selected);
    shown.forEach((c) => next.delete(c.key));
    onSelectedChange(next);
  };

  const lockReason = (c: Candidate): string => {
    switch (c.reason) {
      case 'multi_collection':
        return intl.formatMessage(messages.cantMulti);
      case 'per_user':
        return intl.formatMessage(messages.cantPerUser, {
          user: c.reasonDetail ?? '',
        });
      case 'row_marker':
        return intl.formatMessage(messages.cantRowMarker);
      case 'exclude_label':
        return intl.formatMessage(messages.cantExcludeLabel);
      case 'other_library':
        return intl.formatMessage(messages.cantOtherLibrary, {
          library: c.reasonDetail ?? c.libraryName,
        });
      case 'other_group':
        return intl.formatMessage(messages.cantOtherGroup, {
          group: c.reasonDetail ?? '',
        });
      default:
        return intl.formatMessage(messages.cantOther);
    }
  };

  const status = (key: string): string | null => {
    const member = saved.get(key);
    if (!member || !selected.has(key)) {
      return null;
    }
    if (member.state === 'showing') {
      return intl.formatMessage(messages.memberShowing);
    }
    if (member.state === 'waiting') {
      return member.queuePosition === 1
        ? intl.formatMessage(messages.memberNext)
        : intl.formatMessage(messages.memberWaiting, {
            position: member.queuePosition ?? 0,
          });
    }
    return reasonText(intl, member.reason);
  };

  const fieldClass = '!w-auto flex-none';
  const textButton =
    'rounded text-xs text-indigo-400 hover:text-indigo-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400';

  let list: React.ReactNode;
  if (error && !candidates) {
    list = (
      <div className="p-3">
        <Alert
          type="error"
          title={intl.formatMessage(messages.candidatesError)}
        />
        <Button onClick={onRetry}>
          {intl.formatMessage(messages.tryAgain)}
        </Button>
      </div>
    );
  } else if (loading || !candidates) {
    list = (
      <div className="animate-pulse divide-y divide-gray-800" role="status">
        <span className="sr-only">
          {intl.formatMessage(messages.loadingLabel)}
        </span>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2">
            <div className="h-4 w-4 rounded bg-stone-700" />
            <div className="h-12 w-8 rounded bg-stone-700" />
            <div className="h-4 w-48 rounded bg-stone-700" />
          </div>
        ))}
      </div>
    );
  } else if (shown.length === 0) {
    const noneInLibrary =
      !query && !selectedOnly && typeFilter === 'all' && !allLibraries;
    list = (
      <div className="px-3 py-8 text-center text-sm text-gray-400">
        {query ? (
          <p>{intl.formatMessage(messages.noMatches, { query })}</p>
        ) : noneInLibrary ? (
          <>
            <p>
              {intl.formatMessage(messages.noCandidates, {
                library: libraryName,
              })}
            </p>
            <div className="mt-3">
              <Button buttonSize="sm" disabled={looking} onClick={onLookInPlex}>
                {intl.formatMessage(
                  looking ? messages.lookingInPlex : messages.lookInPlex
                )}
              </Button>
            </div>
          </>
        ) : (
          <p>{intl.formatMessage(messages.nothingSelected)}</p>
        )}
      </div>
    );
  } else {
    list = (
      <ul className="max-h-[60vh] divide-y divide-gray-800 overflow-y-auto">
        {shown.map((c) => {
          const isSelected = selected.has(c.key);
          const locked = !c.selectable && !isSelected;
          const savedMember = saved.get(c.key);
          const line = locked
            ? lockReason(c)
            : !c.selectable
            ? lockReason(c)
            : status(c.key);
          const canShowNext =
            isSelected &&
            savedMember?.state === 'waiting' &&
            (savedMember.queuePosition ?? 0) > 1;
          return (
            <li
              key={c.key}
              className={`flex items-center gap-2 px-3 py-2 ${
                locked ? 'opacity-50' : 'hover:bg-stone-800/60'
              }`}
            >
              <label
                className={`mb-0 flex min-w-0 flex-1 items-center gap-3 ${
                  locked ? 'cursor-not-allowed' : 'cursor-pointer'
                }`}
              >
                {locked ? (
                  <LockClosedIcon
                    className="h-4 w-4 shrink-0 text-gray-500"
                    aria-hidden="true"
                  />
                ) : (
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(c.key)}
                    className="h-4 w-4 shrink-0 rounded border-gray-600 bg-stone-700 text-indigo-500 focus:ring-indigo-500"
                  />
                )}
                {c.posterUrl ? (
                  <img
                    src={c.posterUrl}
                    alt=""
                    loading="lazy"
                    className="h-12 w-8 shrink-0 rounded bg-stone-700 object-cover"
                  />
                ) : (
                  <div className="h-12 w-8 shrink-0 rounded bg-stone-700" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate text-sm font-normal text-gray-200">
                      {c.name}
                    </span>
                    {c.kind === 'preExisting' ? (
                      <PreExistingBadge />
                    ) : (
                      <SourceSubtypeBadge type={c.type} subtype={c.subtype} />
                    )}
                  </span>
                  {line && (
                    <span className="mt-0.5 block text-xs font-normal text-gray-400">
                      {line}
                    </span>
                  )}
                </span>
              </label>
              {canShowNext && (
                <Button
                  buttonSize="sm"
                  disabled={actionsLocked}
                  title={actionsLocked ? lockTip : undefined}
                  onClick={() => onShowNext(c.key)}
                >
                  {intl.formatMessage(messages.showNext)}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-stone-900/60">
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-800 p-3">
        <div className="relative min-w-[10rem] flex-1">
          <MagnifyingGlassIcon
            className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-gray-500"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={intl.formatMessage(messages.searchPlaceholder)}
            aria-label={intl.formatMessage(messages.searchPlaceholder)}
            className="w-full rounded-md border border-stone-500 bg-stone-700 py-2 pl-8 pr-3 text-sm text-white placeholder-gray-400 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          aria-label={intl.formatMessage(messages.filterAllTypes)}
          className={fieldClass}
        >
          <option value="all">
            {intl.formatMessage(messages.filterAllTypes)}
          </option>
          <option value="preExisting">
            {intl.formatMessage(messages.filterInPlex)}
          </option>
          {typeOptions.map((t) => (
            <option key={t} value={t}>
              {getTypeLabel(t)}
            </option>
          ))}
        </select>
        <select
          value={allLibraries ? 'all' : 'this'}
          onChange={(e) => setAllLibraries(e.target.value === 'all')}
          aria-label={intl.formatMessage(messages.fieldLibrary)}
          className={fieldClass}
        >
          <option value="this">
            {intl.formatMessage(messages.filterThisLibrary, {
              library: libraryName,
            })}
          </option>
          <option value="all">
            {intl.formatMessage(messages.filterAllLibraries)}
          </option>
        </select>
        <div
          className="inline-flex rounded-md border border-gray-600"
          role="group"
        >
          {[false, true].map((only) => (
            <button
              key={String(only)}
              type="button"
              aria-pressed={selectedOnly === only}
              onClick={() => setSelectedOnly(only)}
              className={`px-3 py-1.5 text-sm first:rounded-l-md last:rounded-r-md focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 ${
                selectedOnly === only
                  ? 'bg-orange-500/20 text-white'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              {only
                ? intl.formatMessage(messages.showSelected, {
                    count: selected.size,
                  })
                : intl.formatMessage(messages.showAll)}
            </button>
          ))}
        </div>
        <div className="flex gap-3 sm:ml-auto">
          <button type="button" className={textButton} onClick={selectShown}>
            {intl.formatMessage(messages.selectAllShown)}
          </button>
          <button type="button" className={textButton} onClick={clearShown}>
            {intl.formatMessage(messages.clearShown)}
          </button>
        </div>
      </div>
      {list}
    </div>
  );
};

export default MemberPicker;

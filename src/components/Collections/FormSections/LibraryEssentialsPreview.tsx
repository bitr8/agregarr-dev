import type { CollectionFormConfig } from '@app/types/collections';
import { isLibraryEssentialsPattern } from '@app/utils/collections/collectionUtils';
import { useFormikContext } from 'formik';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages({
  discoveryTitle: 'Library Values',
  loading: 'Discovering values in your library...',
  error: 'Failed to load library values.',
  retry: 'Retry',
  selectAll: 'Select All',
  selectNone: 'Select None',
  collectionCount: '{count} collections will be created',
  conflictBadge: 'Existing collection',
  excludeMode: 'Creating all except unchecked',
  includeMode: 'Creating only checked',
});

interface AttributeValue {
  key: string;
  title: string;
  fastKey: string;
}

interface ConflictInfo {
  title: string;
  ratingKey: string;
}

interface DiscoveryResponse {
  values: AttributeValue[];
  conflicts: ConflictInfo[];
}

function groupContentRatings(
  values: AttributeValue[]
): { label: string; items: AttributeValue[] }[] {
  const groups: Record<string, AttributeValue[]> = {};

  for (const v of values) {
    let group: string;
    if (v.title.includes('/')) {
      const prefix = v.title.split('/')[0];
      group = prefix;
    } else if (/^tv-/i.test(v.title)) {
      group = 'TV Ratings';
    } else if (/^\d+$/.test(v.title)) {
      group = 'Age-based';
    } else {
      group = 'General';
    }
    if (!groups[group]) groups[group] = [];
    groups[group].push(v);
  }

  return Object.entries(groups).map(([label, items]) => ({ label, items }));
}

const LibraryEssentialsPreview: React.FC = () => {
  const intl = useIntl();
  const { values, setFieldValue } = useFormikContext<CollectionFormConfig>();

  const libraryId =
    values.libraryId ||
    (values.libraryIds?.length === 1 ? values.libraryIds[0] : undefined);
  const subtype = values.subtype;
  const configId = values.id;
  const rawTemplate = values.template;
  const mediaType = values.mediaType;
  const effectiveTemplate =
    rawTemplate === 'custom'
      ? (mediaType === 'tv'
          ? ((values as Record<string, unknown>).customTVTemplate as string)
          : ((values as Record<string, unknown>)
              .customMovieTemplate as string)) || '{value}'
      : rawTemplate || '{value}';
  const selectionMode = values.selectionMode || 'include';
  const excludeValues = values.excludeValues || [];
  const includeValues = values.includeValues || [];

  const shouldFetch =
    !!libraryId && isLibraryEssentialsPattern(values.type, subtype);

  // Fetch values once per library+subtype; compute conflicts client-side
  const configIdParam = configId ? `?configId=${configId}` : '';
  const swrKey = shouldFetch
    ? `/api/v1/plex/library/${libraryId}/attributes/${subtype}${configIdParam}`
    : null;

  const { data, error, isLoading, mutate } = useSWR<DiscoveryResponse>(swrKey, {
    revalidateOnFocus: false,
  });

  const allValues = data?.values || [];
  const serverCollectionTitles = useMemo(
    () => new Set((data?.conflicts || []).map((c) => c.title.toLowerCase())),
    [data?.conflicts]
  );

  // Reset selection when library or subtype changes (not on template change)
  const resetKey = `${libraryId}:${subtype}`;
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  useEffect(() => {
    if (resetKey !== prevResetKey) {
      setPrevResetKey(resetKey);
      setFieldValue('selectionMode', 'include');
      setFieldValue('excludeValues', []);
      setFieldValue('includeValues', []);
    }
  }, [resetKey, prevResetKey, setFieldValue]);

  const activeCount = useMemo(() => {
    const allKeys = new Set(allValues.map((v) => v.key));
    if (selectionMode === 'exclude') {
      const validExclusions = excludeValues.filter((k) => allKeys.has(k));
      return allValues.length - validExclusions.length;
    }
    return includeValues.filter((k) => allKeys.has(k)).length;
  }, [selectionMode, allValues, excludeValues, includeValues]);

  const isChecked = useCallback(
    (key: string) => {
      if (selectionMode === 'exclude') {
        return !excludeValues.includes(key);
      }
      return includeValues.includes(key);
    },
    [selectionMode, excludeValues, includeValues]
  );

  const toggleValue = useCallback(
    (key: string) => {
      if (selectionMode === 'exclude') {
        const next = excludeValues.includes(key)
          ? excludeValues.filter((k) => k !== key)
          : [...excludeValues, key];
        setFieldValue('excludeValues', next);
      } else {
        const next = includeValues.includes(key)
          ? includeValues.filter((k) => k !== key)
          : [...includeValues, key];
        setFieldValue('includeValues', next);
      }
    },
    [selectionMode, excludeValues, includeValues, setFieldValue]
  );

  const handleSelectAll = useCallback(() => {
    setFieldValue('selectionMode', 'exclude');
    setFieldValue('excludeValues', []);
    setFieldValue('includeValues', []);
  }, [setFieldValue]);

  const handleSelectNone = useCallback(() => {
    setFieldValue('selectionMode', 'include');
    setFieldValue('excludeValues', []);
    setFieldValue('includeValues', []);
  }, [setFieldValue]);

  if (!shouldFetch) {
    if (
      isLibraryEssentialsPattern(values.type, subtype) &&
      values.libraryIds &&
      values.libraryIds.length > 1
    ) {
      return (
        <div className="rounded-md border border-gray-500/20 bg-transparent p-4">
          <p className="text-sm text-gray-400">
            Value preview is available for single-library configurations.
            Selections will apply to all linked libraries.
          </p>
        </div>
      );
    }
    return null;
  }

  if (isLoading) {
    return (
      <div className="rounded-md border border-gray-500/20 bg-transparent p-4">
        <p className="text-sm text-gray-400">
          {intl.formatMessage(messages.loading)}
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-red-500/30 bg-transparent p-4">
        <p className="text-sm text-red-400">
          {intl.formatMessage(messages.error)}
        </p>
        <button
          type="button"
          onClick={() => mutate()}
          className="mt-2 text-sm text-orange-400 hover:text-orange-300"
        >
          {intl.formatMessage(messages.retry)}
        </button>
      </div>
    );
  }

  if (!allValues.length) return null;

  const renderCheckbox = (v: AttributeValue) => {
    const renderedTitle = effectiveTemplate
      ? effectiveTemplate.replace('{value}', v.title)
      : v.title;
    const hasConflict =
      serverCollectionTitles.has(renderedTitle.toLowerCase()) ||
      serverCollectionTitles.has(v.title.toLowerCase());

    return (
      <label
        key={v.key}
        className="flex items-center gap-2 rounded px-2 py-1 hover:bg-stone-700/50"
      >
        <input
          type="checkbox"
          checked={isChecked(v.key)}
          onChange={() => toggleValue(v.key)}
          className="h-4 w-4 rounded border-stone-500 bg-stone-700 text-orange-500 focus:ring-orange-500"
        />
        <span className="text-sm text-gray-200">{v.title}</span>
        {hasConflict && (
          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-400">
            {intl.formatMessage(messages.conflictBadge)}
          </span>
        )}
      </label>
    );
  };

  const isContentRating = subtype === 'contentRating';
  const groups = isContentRating ? groupContentRatings(allValues) : null;

  return (
    <div className="rounded-md border border-gray-500/20 bg-transparent p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-sm font-medium text-gray-300">
          {intl.formatMessage(messages.discoveryTitle)}
        </h4>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSelectAll}
            className="text-xs text-orange-400 hover:text-orange-300"
          >
            {intl.formatMessage(messages.selectAll)}
          </button>
          <button
            type="button"
            onClick={handleSelectNone}
            className="text-xs text-orange-400 hover:text-orange-300"
          >
            {intl.formatMessage(messages.selectNone)}
          </button>
        </div>
      </div>

      <p className="mb-1 text-xs text-gray-500">
        {intl.formatMessage(
          selectionMode === 'exclude'
            ? messages.excludeMode
            : messages.includeMode
        )}
      </p>

      <div className="max-h-64 overflow-y-auto">
        {groups ? (
          groups.map((group) => (
            <div key={group.label} className="mb-2">
              <p className="mb-1 text-xs font-medium text-gray-400">
                {group.label}
              </p>
              <div className="ml-1 space-y-0.5">
                {group.items.map(renderCheckbox)}
              </div>
            </div>
          ))
        ) : (
          <div className="space-y-0.5">{allValues.map(renderCheckbox)}</div>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-gray-500/20 pt-2">
        <span className="text-xs text-gray-400">
          {intl.formatMessage(messages.collectionCount, {
            count: activeCount,
          })}
        </span>
      </div>
    </div>
  );
};

export default LibraryEssentialsPreview;

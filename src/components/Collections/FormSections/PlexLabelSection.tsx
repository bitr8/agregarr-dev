import type { CollectionFormConfig } from '@app/types/collections';
import type React from 'react';
import { defineMessages, useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages({
  plexLabel: 'Plex Label',
  selectLabel: 'Select label...',
  selectLibraryFirst: 'Select a library above first',
  loadingLabels: 'Loading labels...',
  noLabelsFound: 'No labels found in this library',
  plexLabelHelp:
    'Only items in the selected library that carry this label are included. Membership refreshes on each sync.',
});

interface PlexLabelSectionProps {
  values: CollectionFormConfig;
  setFieldValue: (
    field: string,
    value: string | number | boolean | string[] | object | undefined
  ) => void;
  isVisible?: boolean;
}

const PlexLabelSection = ({
  values,
  setFieldValue,
  isVisible = true,
}: PlexLabelSectionProps) => {
  const intl = useIntl();

  const selectedLibraryId =
    (Array.isArray(values.libraryIds) && values.libraryIds[0]) ||
    values.libraryId ||
    '';

  const { data: plexLabelsData, error: plexLabelsError } = useSWR<{
    labels: string[];
  }>(
    isVisible && selectedLibraryId
      ? `/api/v1/plex/labels?libraryId=${encodeURIComponent(selectedLibraryId)}`
      : null
  );

  if (!isVisible) return null;

  return (
    <div>
      <label htmlFor="plexLabel" className="mb-2 block text-sm text-gray-300">
        {intl.formatMessage(messages.plexLabel)}{' '}
        <span className="text-red-500">*</span>
      </label>
      <select
        id="plexLabel"
        name="plexLabel"
        className="w-full rounded-md border border-stone-500 bg-stone-700 px-3 py-2 text-white focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500"
        value={values.plexLabel || ''}
        disabled={!selectedLibraryId || (!plexLabelsData && !plexLabelsError)}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
          setFieldValue('plexLabel', e.target.value || undefined)
        }
      >
        <option value="">
          {!selectedLibraryId
            ? intl.formatMessage(messages.selectLibraryFirst)
            : !plexLabelsData && !plexLabelsError
            ? intl.formatMessage(messages.loadingLabels)
            : intl.formatMessage(messages.selectLabel)}
        </option>
        {plexLabelsData?.labels?.map((label) => (
          <option key={label} value={label}>
            {label}
          </option>
        ))}
      </select>
      {selectedLibraryId &&
        plexLabelsData &&
        plexLabelsData.labels.length === 0 && (
          <p className="mt-1 text-xs text-amber-400">
            {intl.formatMessage(messages.noLabelsFound)}
          </p>
        )}
      <p className="mt-1 text-xs text-gray-400">
        {intl.formatMessage(messages.plexLabelHelp)}
      </p>
    </div>
  );
};

export default PlexLabelSection;

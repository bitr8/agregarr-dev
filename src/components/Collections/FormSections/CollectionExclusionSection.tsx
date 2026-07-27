import type { CollectionFormConfig } from '@app/types/collections';
import { isLibraryEssentialsPattern } from '@app/utils/collections/collectionUtils';
import type React from 'react';
import { useState } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import Select, { type MultiValue } from 'react-select';

const messages = defineMessages({
  exclusionTitle: 'Collection Mutual Exclusion',
  exclusionDescription:
    'Automatically exclude items that exist in other collections. Items from selected collections will be removed from this collection during sync. Note: Exclusions only apply if the excluded collection is active in Plex.',
  enableExclusion: 'Enable collection exclusion',
  selectCollections: 'Select collections to exclude items from',
  collectionPlaceholder: 'Select collections...',
  collectionsSelected:
    '{count, plural, one {# collection selected for exclusion} other {# collections selected for exclusion}}',
});

interface CollectionExclusionSectionProps {
  values: CollectionFormConfig;
  setFieldValue: (field: string, value: unknown) => void;
  allCollectionConfigs: CollectionFormConfig[];
}

const CollectionExclusionSection: React.FC<CollectionExclusionSectionProps> = ({
  values,
  setFieldValue,
  allCollectionConfigs,
}) => {
  const intl = useIntl();

  // Multi-collection patterns should not appear as exclusion targets
  const isMultiCollectionPattern = (config: CollectionFormConfig): boolean => {
    if (config.type === 'overseerr' && config.subtype === 'users') return true;
    if (config.type === 'tmdb' && config.subtype === 'auto_franchise')
      return true;
    if (
      config.type === 'plex' &&
      (config.subtype === 'directors' || config.subtype === 'actors')
    )
      return true;
    if (isLibraryEssentialsPattern(config.type, config.subtype)) return true;
    return false;
  };

  // Get all library IDs this collection is configured for
  const currentLibraryIds =
    values.libraryIds || (values.libraryId ? [values.libraryId] : []);

  const availableCollections = allCollectionConfigs.filter(
    (config) =>
      config.id !== values.id &&
      currentLibraryIds.includes(config.libraryId) &&
      !isMultiCollectionPattern(config)
  );

  const selectedExclusions = values.excludeFromCollections || [];

  const [isManuallyEnabled, setIsManuallyEnabled] = useState(
    selectedExclusions.length > 0
  );
  const isEnabled = isManuallyEnabled || selectedExclusions.length > 0;

  // Early returns after all hooks
  if (isMultiCollectionPattern(values)) return null;
  if (availableCollections.length === 0) return null;

  // Prepare options for react-select
  const options = availableCollections.map((collection) => ({
    value: collection.id,
    label: `${collection.name} - ${collection.libraryName}`,
  }));

  const selectedOptions = options.filter((option) =>
    selectedExclusions.includes(option.value)
  );

  const handleToggleEnabled = () => {
    if (isEnabled) {
      // Disable - clear all exclusions and manually disabled state
      setFieldValue('excludeFromCollections', []);
      setIsManuallyEnabled(false);
    } else {
      // Enable - set manually enabled state
      setIsManuallyEnabled(true);
    }
  };

  const handleSelectionChange = (
    newSelectedOptions: MultiValue<{ value: string; label: string }>
  ) => {
    const values = newSelectedOptions
      ? newSelectedOptions.map((option) => option.value)
      : [];
    setFieldValue('excludeFromCollections', values);
  };

  return (
    <div className="form-row">
      <label htmlFor="excludeFromCollections" className="text-label">
        {intl.formatMessage(messages.exclusionTitle)}
      </label>
      <div className="form-input-area">
        <div className="mb-4 text-sm text-gray-400">
          {intl.formatMessage(messages.exclusionDescription)}
        </div>

        {/* Enable/Disable Toggle */}
        <div className="mb-4">
          <label className="inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              checked={isEnabled}
              onChange={handleToggleEnabled}
              className="form-checkbox"
            />
            <span className="ml-2 text-sm text-white">
              {intl.formatMessage(messages.enableExclusion)}
            </span>
          </label>
        </div>

        {/* Multi-select dropdown - only show when enabled */}
        {isEnabled && (
          <div>
            <label className="mb-2 block text-sm text-gray-300">
              {intl.formatMessage(messages.selectCollections)}
            </label>
            <Select
              isMulti
              options={options}
              value={selectedOptions}
              onChange={handleSelectionChange}
              placeholder={intl.formatMessage(messages.collectionPlaceholder)}
              menuPlacement="auto"
              className="react-select-container"
              classNamePrefix="react-select"
              closeMenuOnSelect={false}
              hideSelectedOptions={false}
            />
            {selectedExclusions.length > 0 && (
              <div className="mt-2 text-xs text-gray-400">
                {intl.formatMessage(messages.collectionsSelected, {
                  count: selectedExclusions.length,
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default CollectionExclusionSection;

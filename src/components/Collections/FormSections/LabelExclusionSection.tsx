import type { CollectionFormConfig } from '@app/types/collections';
import type React from 'react';
import { defineMessages, useIntl } from 'react-intl';
import CreatableSelect from 'react-select/creatable';

const messages = defineMessages({
  labelExclusionTitle: 'Label Exclusion',
  labelExclusionDescription:
    'Items carrying any of these Plex labels are kept out of this collection during sync, for example trailer-placeholder to leave out placeholders. Labels are matched without regard to case.',
  labelExclusionPlaceholder: 'Type a label and press Enter...',
  labelExclusionCreate: 'Exclude label "{label}"',
});

interface LabelOption {
  label: string;
  value: string;
}

interface LabelExclusionSectionProps {
  values: CollectionFormConfig;
  setFieldValue: (field: string, value: unknown) => void;
}

const LabelExclusionSection: React.FC<LabelExclusionSectionProps> = ({
  values,
  setFieldValue,
}) => {
  const intl = useIntl();
  const selected = (values.excludeLabels || []).map((label) => ({
    label,
    value: label,
  }));

  return (
    <div className="form-row">
      <label htmlFor="excludeLabels" className="text-label">
        {intl.formatMessage(messages.labelExclusionTitle)}
      </label>
      <div className="form-input-area">
        <div className="mb-4 text-sm text-gray-400">
          {intl.formatMessage(messages.labelExclusionDescription)}
        </div>
        <CreatableSelect<LabelOption, true>
          inputId="excludeLabels"
          isMulti
          options={[]}
          value={selected}
          onChange={(options) =>
            setFieldValue(
              'excludeLabels',
              options.map((option) => option.value.trim()).filter(Boolean)
            )
          }
          placeholder={intl.formatMessage(messages.labelExclusionPlaceholder)}
          formatCreateLabel={(input) =>
            intl.formatMessage(messages.labelExclusionCreate, { label: input })
          }
          noOptionsMessage={() => null}
          menuPlacement="auto"
          className="react-select-container"
          classNamePrefix="react-select"
        />
      </div>
    </div>
  );
};

export default LabelExclusionSection;

import messages from '@app/components/Rotation/messages';
import RadioCards from '@app/components/Rotation/RadioCards';
import { intervalLabels, weekdayName } from '@app/components/Rotation/utils';
import type { RotationInterval } from '@server/interfaces/api/rotationInterfaces';
import { useIntl } from 'react-intl';

interface IntervalFieldProps {
  interval: RotationInterval;
  weekday: number;
  onChange: (interval: RotationInterval) => void;
  onWeekdayChange: (weekday: number) => void;
}

const OPTIONS: RotationInterval[] = [
  'every_sync',
  '12h',
  'daily',
  'weekly',
  'monthly_random',
];

const IntervalField = ({
  interval,
  weekday,
  onChange,
  onWeekdayChange,
}: IntervalFieldProps) => {
  const intl = useIntl();

  return (
    <RadioCards
      ariaLabel={intl.formatMessage(messages.fieldChange)}
      value={interval}
      onChange={onChange}
      options={OPTIONS.map((option) => ({
        value: option,
        label: intl.formatMessage(messages[intervalLabels[option].label]),
        help: intl.formatMessage(messages[intervalLabels[option].help]),
        extra:
          option === 'weekly' ? (
            <select
              aria-label={intl.formatMessage(messages.fieldWeekday)}
              value={weekday}
              onChange={(e) => onWeekdayChange(Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <option key={d} value={d}>
                  {weekdayName(intl, d)}
                </option>
              ))}
            </select>
          ) : undefined,
      }))}
    />
  );
};

export default IntervalField;

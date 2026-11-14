import messages from '@app/components/Rotation/messages';
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
    <div
      role="radiogroup"
      aria-label={intl.formatMessage(messages.fieldChange)}
      className="grid gap-2"
    >
      {OPTIONS.map((option) => {
        const selected = interval === option;
        const names = intervalLabels[option];
        return (
          <div
            key={option}
            className={`rounded-md border p-3 transition-colors ${
              selected
                ? 'border-orange-500 bg-orange-500/10'
                : 'border-gray-700 hover:border-gray-500'
            }`}
          >
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(option)}
              className="block w-full rounded text-left text-sm font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
            >
              {intl.formatMessage(messages[names.label])}
            </button>
            {selected && (
              <>
                <p className="mt-1 text-xs text-gray-400">
                  {intl.formatMessage(messages[names.help])}
                </p>
                {option === 'weekly' && (
                  <select
                    aria-label={intl.formatMessage(messages.fieldWeekday)}
                    value={weekday}
                    onChange={(e) => onWeekdayChange(Number(e.target.value))}
                    className="mt-2 block w-full rounded-md"
                  >
                    {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                      <option key={d} value={d}>
                        {weekdayName(intl, d)}
                      </option>
                    ))}
                  </select>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default IntervalField;

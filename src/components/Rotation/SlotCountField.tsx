import Button from '@app/components/Common/Button';
import messages from '@app/components/Rotation/messages';
import { MinusIcon, PlusIcon } from '@heroicons/react/24/outline';
import { useIntl } from 'react-intl';

interface SlotCountFieldProps {
  value: number;
  onChange: (value: number) => void;
}

const MIN = 1;
const MAX = 20;

const SlotCountField = ({ value, onChange }: SlotCountFieldProps) => {
  const intl = useIntl();

  return (
    <div>
      <div className="flex items-center gap-3">
        <Button
          buttonSize="sm"
          className="min-h-[40px] min-w-[40px] justify-center sm:min-h-0 sm:min-w-0"
          disabled={value <= MIN}
          aria-label={intl.formatMessage(messages.slotsFewer)}
          onClick={() => onChange(Math.max(MIN, value - 1))}
        >
          <MinusIcon className="h-4 w-4" aria-hidden="true" />
        </Button>
        <output
          aria-label={intl.formatMessage(messages.fieldSlots)}
          className="w-8 text-center text-lg font-medium tabular-nums text-white"
        >
          {value}
        </output>
        <Button
          buttonSize="sm"
          className="min-h-[40px] min-w-[40px] justify-center sm:min-h-0 sm:min-w-0"
          disabled={value >= MAX}
          aria-label={intl.formatMessage(messages.slotsMore)}
          onClick={() => onChange(Math.min(MAX, value + 1))}
        >
          <PlusIcon className="h-4 w-4" aria-hidden="true" />
        </Button>
        <div className="flex min-w-0 flex-wrap gap-1" aria-hidden="true">
          {Array.from({ length: value }, (_, i) => (
            <span
              key={i}
              className="h-9 w-6 rounded-sm border border-gray-600 bg-stone-800/60"
            />
          ))}
        </div>
      </div>
      <p className="label-tip">{intl.formatMessage(messages.slotsTip)}</p>
    </div>
  );
};

export default SlotCountField;

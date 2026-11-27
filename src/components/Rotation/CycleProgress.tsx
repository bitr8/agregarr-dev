import messages from '@app/components/Rotation/messages';
import { useIntl } from 'react-intl';

interface CycleProgressProps {
  shown: number;
  total: number;
}

const CycleProgress = ({ shown, total }: CycleProgressProps) => {
  const intl = useIntl();
  const label = intl.formatMessage(messages.cycleProgress, { shown, total });
  const pct = total > 0 ? Math.min(100, (shown / total) * 100) : 0;

  return (
    <div className="mt-5 flex items-center gap-3">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={Math.min(shown, total)}
        className="h-1.5 flex-1 rounded-full bg-stone-700"
      >
        <div
          className="h-1.5 rounded-full bg-orange-500 transition-[width] duration-500 motion-reduce:transition-none"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="whitespace-nowrap text-sm text-gray-400">{label}</span>
    </div>
  );
};

export default CycleProgress;

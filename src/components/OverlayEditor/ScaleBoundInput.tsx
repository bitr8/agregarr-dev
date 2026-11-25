import { useEffect, useState } from 'react';
import { parseScaleBound } from './colorScaleInputs';

interface ScaleBoundInputProps {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}

export const ScaleBoundInput: React.FC<ScaleBoundInputProps> = ({
  label,
  value,
  onCommit,
}) => {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const next = parseScaleBound(draft, value);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <label className="flex-1 text-xs text-stone-400">
      {label}
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
        className="mt-1 w-full rounded border border-stone-600 bg-stone-700 px-2 py-1 text-xs text-stone-200"
      />
    </label>
  );
};

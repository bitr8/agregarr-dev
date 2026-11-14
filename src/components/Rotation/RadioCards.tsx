import { useRef } from 'react';

export interface RadioCardOption<T extends string> {
  value: T;
  label: string;
  help?: string;
  extra?: React.ReactNode;
}

interface RadioCardsProps<T extends string> {
  options: RadioCardOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}

const RadioCards = <T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: RadioCardsProps<T>) => {
  const group = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const step =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? 1
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
        ? -1
        : 0;
    if (!step) {
      return;
    }
    e.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next].value);
    group.current
      ?.querySelectorAll<HTMLElement>('[role="radio"]')
      [next]?.focus();
  };

  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={ariaLabel}
      className="grid gap-2"
    >
      {options.map((option, i) => {
        const selected = option.value === value;
        return (
          <div
            key={option.value}
            className={`rounded-md border transition-colors ${
              selected
                ? 'border-orange-500 bg-orange-500/10'
                : 'border-gray-700 hover:border-gray-500'
            }`}
          >
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(option.value)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className="block min-h-[44px] w-full rounded-md p-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
            >
              <span className="block text-sm font-medium text-white">
                {option.label}
              </span>
              {selected && option.help && (
                <span className="mt-1 block text-xs font-normal text-gray-400">
                  {option.help}
                </span>
              )}
            </button>
            {selected && option.extra && (
              <div className="px-3 pb-3">{option.extra}</div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default RadioCards;

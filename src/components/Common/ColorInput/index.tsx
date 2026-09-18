import {
  parseColorInput,
  toSwatchHex,
} from '@app/components/Common/ColorInput/color';
import { useEffect, useState } from 'react';
import { defineMessages, useIntl } from 'react-intl';

const messages = defineMessages({
  textInputPlaceholder: '#rrggbb or rgba()',
  textInputAriaLabel: 'Color value (hex or rgba)',
});

interface ColorInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
}

const ColorInput = ({ value, onChange, disabled, id }: ColorInputProps) => {
  const intl = useIntl();
  const [text, setText] = useState(value);

  useEffect(() => {
    if (parseColorInput(text) !== value) {
      setText(value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className="flex items-center gap-1">
      <input
        id={id}
        type="color"
        value={toSwatchHex(value)}
        disabled={disabled}
        onChange={(e) => onChange((e.target as HTMLInputElement).value)}
        className="h-8 w-10 shrink-0 cursor-pointer rounded border border-stone-600 bg-transparent p-0 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <input
        type="text"
        value={text}
        disabled={disabled}
        placeholder={intl.formatMessage(messages.textInputPlaceholder)}
        aria-label={intl.formatMessage(messages.textInputAriaLabel)}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          const parsed = parseColorInput(next);
          if (parsed) {
            onChange(parsed);
          }
        }}
        onBlur={() => setText(parseColorInput(text) ?? value)}
        className="h-8 min-w-0 flex-1 rounded border border-stone-600 bg-stone-700 px-1 font-mono text-xs disabled:cursor-not-allowed disabled:opacity-50"
      />
    </div>
  );
};

export default ColorInput;

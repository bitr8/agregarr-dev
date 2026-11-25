export interface SingleLineFontProps {
  fontFamily?: string;
  fontSize: number;
  fontWeight?: string;
  fontStyle?: string;
}

export function singleLineFont(props: SingleLineFontProps): string {
  return `${props.fontStyle === 'italic' ? 'italic ' : ''}${
    props.fontWeight === 'bold' ? 'bold ' : ''
  }${props.fontSize}px "${(props.fontFamily || '').replace(/['"]/g, '')}"`;
}

export function singleLineAnchorX(
  textAlign: string | undefined,
  width: number
): number {
  return textAlign === 'center' ? width / 2 : textAlign === 'right' ? width : 0;
}

export function normaliseSingleLine(text: string): string {
  return text
    .replace(/[\r\n]/g, '')
    .replace(/[\t ]+/g, ' ')
    .trim();
}

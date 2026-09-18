/** Quote a CSV field and neutralize spreadsheet formula prefixes. */
export function csvCell(value: string | number | undefined): string {
  const text = value === undefined ? '' : String(value);
  const spreadsheetSafe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${spreadsheetSafe.replace(/"/g, '""')}"`;
}

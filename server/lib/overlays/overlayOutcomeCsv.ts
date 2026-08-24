import type { OverlayLibraryOutcomeDetails } from './OverlayLibraryService';

const csvCell = (value: string | number | undefined): string => {
  const text = value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
};

/** Serialize the current in-memory overlay run into a spreadsheet-safe CSV. */
export function serializeOverlayOutcomeCsv(
  libraries: readonly OverlayLibraryOutcomeDetails[]
): string {
  const rows = [
    [
      'Processed At',
      'Library',
      'Outcome',
      'Artwork',
      'Title',
      'File Path',
      'Plex Rating Key',
      'Message',
    ].map(csvCell),
  ];

  for (const library of libraries) {
    for (const item of library.items) {
      rows.push(
        [
          new Date(item.processedAt).toISOString(),
          library.libraryName,
          item.outcome,
          item.target === 'main' ? 'poster' : item.target,
          item.title,
          item.filePath,
          item.ratingKey,
          item.message,
        ].map(csvCell)
      );
    }
  }

  return `${rows.map((row) => row.join(',')).join('\r\n')}\r\n`;
}

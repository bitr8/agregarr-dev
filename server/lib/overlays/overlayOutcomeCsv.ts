import { csvCell } from '@server/utils/csv';
import type { OverlayLibraryOutcomeDetails } from './OverlayLibraryService';

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
      'Older Entries Omitted',
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
          library.omittedItems,
        ].map(csvCell)
      );
    }
  }

  return `${rows.map((row) => row.join(',')).join('\r\n')}\r\n`;
}

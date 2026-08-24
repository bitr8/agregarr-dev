import type { CollectionOutcome } from './CollectionSyncProgress';

const csvCell = (value: string | number | undefined): string => {
  const text = value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
};

/** Serialize the current in-memory collection sync run into a CSV log. */
export function serializeCollectionOutcomeCsv(
  outcomes: readonly CollectionOutcome[]
): string {
  const rows = [
    [
      'Processed At',
      'Outcome',
      'Collection',
      'Source Type',
      'Config ID',
      'Created',
      'Updated',
      'Duration (ms)',
      'Error',
    ].map(csvCell),
  ];

  for (const outcome of outcomes) {
    rows.push(
      [
        new Date(outcome.processedAt).toISOString(),
        outcome.outcome,
        outcome.name,
        outcome.sourceType,
        outcome.configId,
        outcome.created,
        outcome.updated,
        outcome.durationMs,
        outcome.errorMessage,
      ].map(csvCell)
    );
  }

  return `${rows.map((row) => row.join(',')).join('\r\n')}\r\n`;
}

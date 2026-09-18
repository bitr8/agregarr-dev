/**
 * Process every value while keeping at most `limit` asynchronous workers active.
 */
export async function mapWithConcurrency<T>(
  values: readonly T[],
  limit: number,
  worker: (value: T, index: number) => Promise<void>
): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('Concurrency limit must be a positive integer');
  }

  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      await worker(values[index], index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => runWorker())
  );
}

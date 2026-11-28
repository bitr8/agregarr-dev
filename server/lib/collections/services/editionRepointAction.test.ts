import { expect, it } from 'vitest';
import { editionRepointAction } from './editionRepointAction';

const RUN = '2026-11-28T00:00:00.000Z';
const OLD = '2026-11-27T00:00:00.000Z';

it.each([
  [false, false, OLD, 'done'],
  [false, true, RUN, 'done'],
  [true, true, OLD, 'remove'],
  [true, false, RUN, 'remove'],
  [true, false, OLD, 'defer'],
])(
  'edition=%s real=%s lastSyncedAt=%s -> %s',
  (editionInCollection, realInCollection, lastSyncedAt, expected) => {
    expect(
      editionRepointAction({
        editionInCollection,
        realInCollection,
        lastSyncedAt,
        runStartedAt: RUN,
      })
    ).toBe(expected);
  }
);

it('treats a missing or older lastSyncedAt as not synced this run', () => {
  const runStartedAt = '2026-11-28T00:00:00.000Z';
  const base = { editionInCollection: true, realInCollection: false };
  expect(
    editionRepointAction({ ...base, lastSyncedAt: undefined, runStartedAt })
  ).toBe('defer');
  expect(
    editionRepointAction({
      ...base,
      lastSyncedAt: '2026-11-27T23:59:59.000Z',
      runStartedAt,
    })
  ).toBe('defer');
  expect(
    editionRepointAction({ ...base, lastSyncedAt: runStartedAt, runStartedAt })
  ).toBe('remove');
});

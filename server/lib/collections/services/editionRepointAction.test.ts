import { expect, it } from 'vitest';
import { editionRepointAction } from './editionRepointAction';

it.each([
  [false, false, false, 'done'],
  [false, true, true, 'done'],
  [true, true, false, 'remove'],
  [true, false, true, 'remove'],
  [true, false, false, 'defer'],
])(
  'edition=%s real=%s synced=%s -> %s',
  (editionInCollection, realInCollection, configSyncedThisRun, expected) => {
    expect(
      editionRepointAction({
        editionInCollection,
        realInCollection,
        configSyncedThisRun,
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

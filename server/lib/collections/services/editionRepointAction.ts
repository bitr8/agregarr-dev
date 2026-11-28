export type EditionRepointAction = 'remove' | 'done' | 'defer';

export function editionRepointAction(args: {
  editionInCollection: boolean;
  realInCollection: boolean;
  configSyncedThisRun?: boolean;
  lastSyncedAt?: string;
  runStartedAt?: string;
}): EditionRepointAction {
  const synced =
    args.configSyncedThisRun ??
    (!!args.lastSyncedAt &&
      !!args.runStartedAt &&
      Date.parse(args.lastSyncedAt) >= Date.parse(args.runStartedAt));

  if (!args.editionInCollection) return 'done';
  if (args.realInCollection || synced) return 'remove';
  return 'defer';
}

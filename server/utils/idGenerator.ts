import { getSettings } from '@server/lib/settings';

/**
 * Generates sequential numeric IDs starting from 10000
 * All collection configs share the same ID space to avoid conflicts
 *
 * The counter (nextConfigId) is a floor — generateId() also scans
 * existing config arrays to find the actual max, preventing collisions
 * when the counter drifts behind due to settings.load() races or
 * crash recovery.
 */
export class IdGenerator {
  private static readonly STARTING_ID = 10000;

  public static generateId(): string {
    const settings = getSettings();

    const allIds = [
      ...(settings.plex.collectionConfigs || []),
      ...(settings.plex.hubConfigs || []),
      ...(settings.plex.preExistingCollectionConfigs || []),
    ]
      .map((c) => parseInt(c.id, 10))
      .filter((n) => !isNaN(n) && n >= this.STARTING_ID);

    const maxExisting = allIds.reduce(
      (max, n) => Math.max(max, n),
      this.STARTING_ID - 1
    );

    const counterValue = settings.main.nextConfigId ?? this.STARTING_ID;
    const nextId = Math.max(maxExisting + 1, counterValue);

    settings.main.nextConfigId = nextId + 1;
    settings.save();

    return nextId.toString();
  }
}

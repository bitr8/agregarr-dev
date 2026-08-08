import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `useLatestSeasonDate` on overlay_library_config: when the "Show poster
 * countdown" setting requires every season to be leaving, this picks which end of
 * the departure window dates the show poster - the last season to go (the day the
 * show disappears from Plex) or the first. Defaults to 1, the day the show is
 * fully gone, which is the meaning the all-seasons rule shipped with.
 */
export class AddUseLatestSeasonDate1788000000000 implements MigrationInterface {
  name = 'AddUseLatestSeasonDate1788000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Guarded so the migration is safe to re-run if it ever partially applied.
    // down() intentionally leaves the column, since SQLite can't cleanly drop
    // it, so a revert+run would otherwise hit "duplicate column name".
    const hasColumn = await queryRunner.hasColumn(
      'overlay_library_config',
      'useLatestSeasonDate'
    );
    if (!hasColumn) {
      await queryRunner.query(
        `ALTER TABLE "overlay_library_config" ADD COLUMN "useLatestSeasonDate" boolean NOT NULL DEFAULT 1`
      );
    }
  }

  public async down(): Promise<void> {
    // SQLite doesn't support DROP COLUMN cleanly. The column has a default and
    // is ignored by older code, so we leave it in place (mirrors
    // AddRequireAllSeasonsLeaving1787000000000).
  }
}

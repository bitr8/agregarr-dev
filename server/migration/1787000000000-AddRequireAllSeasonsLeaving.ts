import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `requireAllSeasonsLeaving` on overlay_library_config: sub-toggle of
 * `enableMaintainerrSeasonOverlays` (per show library) that holds a show poster's
 * deletion countdown back until every one of its seasons is scheduled to leave,
 * dating it by the last season to go. Defaults to 0, which keeps the existing
 * behaviour where any leaving season puts its date on the show.
 */
export class AddRequireAllSeasonsLeaving1787000000000
  implements MigrationInterface
{
  name = 'AddRequireAllSeasonsLeaving1787000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Guarded so the migration is safe to re-run if it ever partially applied.
    // down() intentionally leaves the column, since SQLite can't cleanly drop
    // it, so a revert+run would otherwise hit "duplicate column name".
    const hasColumn = await queryRunner.hasColumn(
      'overlay_library_config',
      'requireAllSeasonsLeaving'
    );
    if (!hasColumn) {
      await queryRunner.query(
        `ALTER TABLE "overlay_library_config" ADD COLUMN "requireAllSeasonsLeaving" boolean NOT NULL DEFAULT 0`
      );
    }
  }

  public async down(): Promise<void> {
    // SQLite doesn't support DROP COLUMN cleanly. The column has a default and
    // is ignored by older code, so we leave it in place (mirrors
    // AddMaintainerrSeasonOverlays1783000000000).
  }
}

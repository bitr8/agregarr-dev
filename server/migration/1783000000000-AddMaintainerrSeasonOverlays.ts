import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Foundations for Maintainerr season deletion-countdown overlays.
 *
 * - `enableMaintainerrSeasonOverlays` on overlay_library_config: opt-in toggle
 *   (per show library) for applying deletion-countdown overlays to seasons that
 *   belong to a Maintainerr collection with a deletion schedule.
 * - `itemType` on media_item_metadata: records what kind of Plex item a tracked
 *   overlay row belongs to ('movie' | 'show' | 'season'), so season rows can be
 *   found for their own cleanup lifecycle without misclassifying movie/show rows.
 */
export class AddMaintainerrSeasonOverlays1783000000000
  implements MigrationInterface
{
  name = 'AddMaintainerrSeasonOverlays1783000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Guarded so the migration is safe to re-run if it ever partially applied
    // (down() intentionally leaves the columns, since SQLite can't cleanly drop
    // them — so a revert+run would otherwise hit "duplicate column name").
    const hasConfigColumn = await queryRunner.hasColumn(
      'overlay_library_config',
      'enableMaintainerrSeasonOverlays'
    );
    if (!hasConfigColumn) {
      await queryRunner.query(
        `ALTER TABLE "overlay_library_config" ADD COLUMN "enableMaintainerrSeasonOverlays" boolean NOT NULL DEFAULT 0`
      );
    }

    const hasItemTypeColumn = await queryRunner.hasColumn(
      'media_item_metadata',
      'itemType'
    );
    if (!hasItemTypeColumn) {
      await queryRunner.query(
        `ALTER TABLE "media_item_metadata" ADD COLUMN "itemType" varchar`
      );
    }
  }

  public async down(): Promise<void> {
    // SQLite doesn't support DROP COLUMN cleanly. Both columns are nullable /
    // have a default and are ignored by older code, so we leave them in place
    // (mirrors AddEpisodeMediaScanning1782000000000).
  }
}

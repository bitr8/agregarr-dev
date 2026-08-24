import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Selectable artwork targets for the full and quick overlay jobs. Existing TV
 * libraries opt into all supported artwork so the first upgraded run covers
 * shows, seasons, and episodes; movie libraries remain main-poster only.
 */
export class AddOverlaySyncTargets1790000000000 implements MigrationInterface {
  name = 'AddOverlaySyncTargets1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (
      !(await queryRunner.hasColumn(
        'overlay_library_config',
        'fullSyncTargets'
      ))
    ) {
      await queryRunner.query(
        `ALTER TABLE "overlay_library_config" ADD COLUMN "fullSyncTargets" text NOT NULL DEFAULT '["main"]'`
      );
      await queryRunner.query(
        `UPDATE "overlay_library_config" SET "fullSyncTargets" = '["main","season","episode"]' WHERE "mediaType" = 'show'`
      );
    }

    if (
      !(await queryRunner.hasColumn(
        'overlay_library_config',
        'quickSyncTargets'
      ))
    ) {
      await queryRunner.query(
        `ALTER TABLE "overlay_library_config" ADD COLUMN "quickSyncTargets" text NOT NULL DEFAULT '["main"]'`
      );
      await queryRunner.query(
        `UPDATE "overlay_library_config" SET "quickSyncTargets" = '["main","season","episode"]' WHERE "mediaType" = 'show'`
      );
    }
  }

  public async down(): Promise<void> {
    // SQLite cannot safely drop these columns in place. Older versions ignore
    // them, so retaining the data is the reversible option used by nearby
    // overlay-library migrations as well.
  }
}

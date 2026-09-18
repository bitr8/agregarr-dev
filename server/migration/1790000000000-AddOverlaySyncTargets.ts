import type { MigrationInterface, QueryRunner } from 'typeorm';

// Child artwork requires an explicit per-library opt-in.
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
    }
  }

  public async down(): Promise<void> {
    // SQLite cannot safely drop these columns in place. Older versions ignore
    // them, so retaining the data is the reversible option used by nearby
    // overlay-library migrations as well.
  }
}

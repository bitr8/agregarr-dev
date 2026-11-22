import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEpisodeVersionCount1793000000000 implements MigrationInterface {
  name = 'AddEpisodeVersionCount1793000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('episode_media_cache', 'versionCount')) {
      return;
    }
    await queryRunner.query(
      `ALTER TABLE "episode_media_cache" ADD COLUMN "versionCount" integer`
    );
  }

  public async down(): Promise<void> {
    // SQLite can't drop the column cleanly; ignored by older code.
  }
}

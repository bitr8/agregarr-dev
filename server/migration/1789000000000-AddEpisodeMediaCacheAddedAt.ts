import type { MigrationInterface, QueryRunner } from 'typeorm';

// Nullable: rows written before this column read as unknown until re-saved.
export class AddEpisodeMediaCacheAddedAt1789000000000
  implements MigrationInterface
{
  name = 'AddEpisodeMediaCacheAddedAt1789000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasColumn = await queryRunner.hasColumn(
      'episode_media_cache',
      'addedAt'
    );
    if (!hasColumn) {
      await queryRunner.query(
        `ALTER TABLE "episode_media_cache" ADD COLUMN "addedAt" integer`
      );
    }
  }

  public async down(): Promise<void> {
    // SQLite can't drop the column cleanly; nullable and ignored by older code.
  }
}

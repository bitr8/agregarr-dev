import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEpisodeMediaScanning1782000000000
  implements MigrationInterface
{
  name = 'AddEpisodeMediaScanning1782000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add enableEpisodeScanning to overlay_library_config
    await queryRunner.query(
      `ALTER TABLE "overlay_library_config" ADD COLUMN "enableEpisodeScanning" boolean NOT NULL DEFAULT 0`
    );

    // Create episode_media_cache table
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "episode_media_cache" (
        "serverId" varchar NOT NULL,
        "libraryId" varchar NOT NULL,
        "ratingKey" varchar NOT NULL,
        "showRatingKey" varchar NOT NULL,
        "seasonRatingKey" varchar NOT NULL,
        "seasonNumber" integer NOT NULL,
        "episodeNumber" integer NOT NULL,
        "resolution" varchar NOT NULL,
        "hdr" boolean NOT NULL DEFAULT 0,
        "dolbyVision" boolean NOT NULL DEFAULT 0,
        "dolbyVisionProfile" integer,
        "videoCodec" varchar NOT NULL DEFAULT '',
        "audioCodec" varchar NOT NULL DEFAULT '',
        "audioChannels" integer NOT NULL DEFAULT 2,
        "bitDepth" integer NOT NULL DEFAULT 8,
        "mediaHash" varchar NOT NULL DEFAULT '',
        "hasStreamDetail" boolean NOT NULL DEFAULT 0,
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY ("serverId", "libraryId", "ratingKey")
      )`
    );

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_emc_show" ON "episode_media_cache" ("serverId", "libraryId", "showRatingKey")`
    );

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_emc_season" ON "episode_media_cache" ("serverId", "libraryId", "seasonRatingKey")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_emc_season"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_emc_show"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "episode_media_cache"`);

    // SQLite doesn't support DROP COLUMN, but TypeORM's synchronize handles it
    // For safety, we just leave the column (it has a default and won't break older code)
  }
}

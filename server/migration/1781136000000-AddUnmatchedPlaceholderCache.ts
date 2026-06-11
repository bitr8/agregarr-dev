import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUnmatchedPlaceholderCache1781136000000
  implements MigrationInterface
{
  name = 'AddUnmatchedPlaceholderCache1781136000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "unmatched_placeholder_cache" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "libraryId" varchar NOT NULL, "mediaType" varchar(10) NOT NULL, "tmdbId" integer NOT NULL, "title" varchar NOT NULL, "attemptCount" integer NOT NULL DEFAULT (1), "expiresAt" datetime NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_upc_library_media_tmdb" ON "unmatched_placeholder_cache" ("libraryId", "mediaType", "tmdbId")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_upc_expiresAt" ON "unmatched_placeholder_cache" ("expiresAt")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_upc_expiresAt"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_upc_library_media_tmdb"`
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "unmatched_placeholder_cache"`
    );
  }
}

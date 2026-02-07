import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTmdbResolutionCache1738900000000 implements MigrationInterface {
  name = 'AddTmdbResolutionCache1738900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "tmdb_resolution_cache" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "lookupKey" varchar NOT NULL, "originalTitle" varchar NOT NULL, "year" integer NOT NULL, "tmdbId" integer, "mediaType" varchar(10), "matchScore" real, "expiresAt" datetime NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_trc_lookupKey" ON "tmdb_resolution_cache" ("lookupKey")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_trc_expiresAt" ON "tmdb_resolution_cache" ("expiresAt")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trc_expiresAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trc_lookupKey"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tmdb_resolution_cache"`);
  }
}

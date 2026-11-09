import type { MigrationInterface, QueryRunner } from 'typeorm';

// Existing rows were scanned without these fields; resetting hasStreamDetail
// makes the next stream-detail scan refetch them instead of trusting the cache.
export class AddEpisodeHdr10PlusAudioProfile1792000000000
  implements MigrationInterface
{
  name = 'AddEpisodeHdr10PlusAudioProfile1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasHdr10Plus = await queryRunner.hasColumn(
      'episode_media_cache',
      'hdr10Plus'
    );
    const hasAudioProfile = await queryRunner.hasColumn(
      'episode_media_cache',
      'audioProfile'
    );
    if (hasHdr10Plus && hasAudioProfile) return;

    if (!hasHdr10Plus) {
      await queryRunner.query(
        `ALTER TABLE "episode_media_cache" ADD COLUMN "hdr10Plus" boolean NOT NULL DEFAULT 0`
      );
    }
    if (!hasAudioProfile) {
      await queryRunner.query(
        `ALTER TABLE "episode_media_cache" ADD COLUMN "audioProfile" varchar`
      );
    }
    await queryRunner.query(
      `UPDATE "episode_media_cache" SET "hasStreamDetail" = 0`
    );
  }

  public async down(): Promise<void> {
    // SQLite can't drop the columns cleanly; ignored by older code.
  }
}

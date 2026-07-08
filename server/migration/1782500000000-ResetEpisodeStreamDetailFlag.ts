import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The episode media cache previously stamped hasStreamDetail from a batch-level
 * flag, so rows that fell back to lightweight data on a partial metadata fetch
 * were recorded as having stream detail. Reset the flag so the corrected
 * per-row logic re-verifies every row on the next scan. Only libraries with an
 * HDR/DV/bit-depth overlay actually re-fetch; resolution-only libraries leave
 * the rows lightweight and do no extra work.
 */
export class ResetEpisodeStreamDetailFlag1782500000000
  implements MigrationInterface
{
  name = 'ResetEpisodeStreamDetailFlag1782500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "episode_media_cache" SET "hasStreamDetail" = 0`
    );
  }

  public async down(): Promise<void> {
    // No-op: the flag is repopulated by the next scan, nothing to revert.
  }
}

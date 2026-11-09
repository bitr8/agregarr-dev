import { AddEpisodeHdr10PlusAudioProfile1792000000000 } from '@server/migration/1792000000000-AddEpisodeHdr10PlusAudioProfile';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('AddEpisodeHdr10PlusAudioProfile migration', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = new DataSource({ type: 'sqlite', database: ':memory:' });
    await dataSource.initialize();
    await dataSource.query(
      `CREATE TABLE "episode_media_cache" ("ratingKey" varchar PRIMARY KEY, "hasStreamDetail" boolean NOT NULL DEFAULT 0)`
    );
    await dataSource.query(
      `INSERT INTO "episode_media_cache" ("ratingKey", "hasStreamDetail") VALUES ('a', 1), ('b', 1)`
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('adds both columns and forces a stream refetch', async () => {
    const runner = dataSource.createQueryRunner();
    await new AddEpisodeHdr10PlusAudioProfile1792000000000().up(runner);

    const rows = await dataSource.query(
      `SELECT "ratingKey", "hasStreamDetail", "hdr10Plus", "audioProfile" FROM "episode_media_cache" ORDER BY "ratingKey"`
    );
    expect(rows).toEqual([
      { ratingKey: 'a', hasStreamDetail: 0, hdr10Plus: 0, audioProfile: null },
      { ratingKey: 'b', hasStreamDetail: 0, hdr10Plus: 0, audioProfile: null },
    ]);
    await runner.release();
  });

  it('is a no-op when run again', async () => {
    const runner = dataSource.createQueryRunner();
    const migration = new AddEpisodeHdr10PlusAudioProfile1792000000000();
    await migration.up(runner);
    await dataSource.query(
      `UPDATE "episode_media_cache" SET "hasStreamDetail" = 1, "hdr10Plus" = 1, "audioProfile" = 'plus_atmos'`
    );

    await migration.up(runner);

    const [row] = await dataSource.query(
      `SELECT "hasStreamDetail", "hdr10Plus", "audioProfile" FROM "episode_media_cache" WHERE "ratingKey" = 'a'`
    );
    expect(row).toEqual({
      hasStreamDetail: 1,
      hdr10Plus: 1,
      audioProfile: 'plus_atmos',
    });
    await runner.release();
  });
});

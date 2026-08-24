import { AddOverlaySyncTargets1790000000000 } from '@server/migration/1790000000000-AddOverlaySyncTargets';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('AddOverlaySyncTargets migration', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = new DataSource({ type: 'sqlite', database: ':memory:' });
    await dataSource.initialize();
    await dataSource.query(
      `CREATE TABLE "overlay_library_config" ("id" integer PRIMARY KEY, "mediaType" varchar NOT NULL)`
    );
    await dataSource.query(
      `INSERT INTO "overlay_library_config" ("id", "mediaType") VALUES (1, 'movie'), (2, 'show')`
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('enables every TV artwork target while keeping movies main-only', async () => {
    const migration = new AddOverlaySyncTargets1790000000000();
    const runner = dataSource.createQueryRunner();

    await migration.up(runner);

    const rows = await dataSource.query(
      `SELECT "id", "fullSyncTargets", "quickSyncTargets" FROM "overlay_library_config" ORDER BY "id"`
    );
    expect(rows).toEqual([
      {
        id: 1,
        fullSyncTargets: '["main"]',
        quickSyncTargets: '["main"]',
      },
      {
        id: 2,
        fullSyncTargets: '["main","season","episode"]',
        quickSyncTargets: '["main","season","episode"]',
      },
    ]);

    await runner.release();
  });

  it('does not overwrite choices if the guarded migration is invoked again', async () => {
    const migration = new AddOverlaySyncTargets1790000000000();
    const runner = dataSource.createQueryRunner();
    await migration.up(runner);
    await dataSource.query(
      `UPDATE "overlay_library_config" SET "fullSyncTargets" = '[]', "quickSyncTargets" = '["episode"]' WHERE "id" = 2`
    );

    await migration.up(runner);

    const [show] = await dataSource.query(
      `SELECT "fullSyncTargets", "quickSyncTargets" FROM "overlay_library_config" WHERE "id" = 2`
    );
    expect(show).toEqual({
      fullSyncTargets: '[]',
      quickSyncTargets: '["episode"]',
    });

    await runner.release();
  });
});

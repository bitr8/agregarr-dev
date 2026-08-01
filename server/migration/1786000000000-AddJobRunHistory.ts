import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJobRunHistory1786000000000 implements MigrationInterface {
  name = 'AddJobRunHistory1786000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasTable = await queryRunner.hasTable('job_run_history');
    if (!hasTable) {
      await queryRunner.query(`
        CREATE TABLE "job_run_history" (
          "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
          "jobId" varchar NOT NULL,
          "startedAt" varchar NOT NULL,
          "finishedAt" varchar,
          "durationMs" integer,
          "outcome" varchar NOT NULL,
          "error" varchar,
          "detail" text
        )
      `);
      await queryRunner.query(
        `CREATE INDEX "idx_job_run_history_job_id" ON "job_run_history" ("jobId")`
      );
    } else {
      const hasDetail = await queryRunner.hasColumn(
        'job_run_history',
        'detail'
      );
      if (!hasDetail) {
        await queryRunner.query(
          `ALTER TABLE "job_run_history" ADD COLUMN "detail" text`
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "job_run_history"`);
  }
}

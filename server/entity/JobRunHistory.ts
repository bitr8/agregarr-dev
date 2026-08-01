import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
@Index('idx_job_run_history_job_id', ['jobId'])
export class JobRunHistory {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public jobId: string;

  @Column()
  public startedAt: string;

  @Column({ type: 'varchar', nullable: true })
  public finishedAt: string | null;

  @Column({ type: 'integer', nullable: true })
  public durationMs: number | null;

  @Column()
  public outcome: string;

  @Column({ type: 'varchar', nullable: true })
  public error: string | null;

  @Column({ type: 'simple-json', nullable: true })
  public detail: Record<string, unknown> | null;
}

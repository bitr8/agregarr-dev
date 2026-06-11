import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('unmatched_placeholder_cache')
@Index(['libraryId', 'mediaType', 'tmdbId'], { unique: true })
export class UnmatchedPlaceholderCache {
  constructor(init?: Partial<UnmatchedPlaceholderCache>) {
    Object.assign(this, init);
  }

  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar' })
  public libraryId: string;

  @Column({ type: 'varchar', length: 10 })
  public mediaType: 'movie' | 'tv';

  @Column({ type: 'integer' })
  public tmdbId: number;

  @Column({ type: 'varchar' })
  public title: string;

  @Column({ type: 'integer', default: 1 })
  public attemptCount: number;

  @Column({ type: 'datetime' })
  @Index()
  public expiresAt: Date;

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;
}

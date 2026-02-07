import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('tmdb_resolution_cache')
export class TmdbResolutionCache {
  constructor(init?: Partial<TmdbResolutionCache>) {
    Object.assign(this, init);
  }

  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar' })
  @Index({ unique: true })
  public lookupKey: string;

  @Column({ type: 'varchar' })
  public originalTitle: string;

  @Column({ type: 'integer' })
  public year: number;

  @Column({ type: 'integer', nullable: true })
  public tmdbId: number | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  public mediaType: 'movie' | 'tv' | null;

  @Column({ type: 'real', nullable: true })
  public matchScore: number | null;

  @Column({ type: 'datetime' })
  @Index()
  public expiresAt: Date;

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;
}

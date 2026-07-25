import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Persistent cache for per-episode media capabilities.
 * Populated by PlexEpisodeMediaScanner, consumed by EpisodeMediaAggregator.
 * 7-day TTL; hash-based invalidation detects media file changes.
 */
@Entity()
@Index('IDX_emc_show', ['serverId', 'libraryId', 'showRatingKey'])
@Index('IDX_emc_season', ['serverId', 'libraryId', 'seasonRatingKey'])
export class EpisodeMediaCache {
  @PrimaryColumn()
  public serverId: string;

  @PrimaryColumn()
  public libraryId: string;

  @PrimaryColumn()
  public ratingKey: string;

  @Column()
  public showRatingKey: string;

  @Column()
  public seasonRatingKey: string;

  @Column()
  public seasonNumber: number;

  @Column()
  public episodeNumber: number;

  @Column()
  public resolution: string;

  @Column({ type: 'boolean' })
  public hdr: boolean;

  @Column({ type: 'boolean' })
  public dolbyVision: boolean;

  @Column({ type: 'integer', nullable: true })
  public dolbyVisionProfile?: number;

  @Column()
  public videoCodec: string;

  @Column()
  public audioCodec: string;

  @Column()
  public audioChannels: number;

  @Column()
  public bitDepth: number;

  @Column()
  public mediaHash: string;

  @Column({ type: 'boolean', default: false })
  public hasStreamDetail: boolean;

  @UpdateDateColumn()
  public updatedAt: Date;
}

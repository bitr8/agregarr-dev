import type { OverlayArtworkTarget } from '@server/lib/overlays/overlayTargets';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Configuration for which overlay templates are enabled for a specific library
 */
export interface EnabledOverlay {
  templateId: number; // Reference to OverlayTemplate
  enabled: boolean; // Whether this overlay is active
  layerOrder: number; // Stacking order (0 = bottom, higher = top)
}

/**
 * Database entity for library-specific overlay configuration
 */
@Entity()
export class OverlayLibraryConfig {
  constructor(init?: Partial<OverlayLibraryConfig>) {
    Object.assign(this, init);
  }

  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ unique: true })
  public libraryId: string; // Plex library key

  @Column()
  public libraryName: string; // Friendly name for display

  @Column()
  public mediaType: 'movie' | 'show';

  @Column({ type: 'simple-json' })
  public enabledOverlays: EnabledOverlay[];

  @Column({ type: 'simple-json', default: '["main"]' })
  public fullSyncTargets: OverlayArtworkTarget[];

  @Column({ type: 'simple-json', default: '["main"]' })
  public quickSyncTargets: OverlayArtworkTarget[];

  @Column({ type: 'varchar', nullable: true })
  public tmdbLanguage?: string; // ISO language code for TMDB poster metadata (e.g., 'en', 'fr', 'pt-BR')

  @Column({ type: 'boolean', default: false })
  public enableEpisodeScanning: boolean;

  @Column({ type: 'boolean', default: false })
  public enableMaintainerrSeasonOverlays: boolean;

  // "Show poster countdown": hold the show poster's countdown back until every
  // season of the show is scheduled to leave. Independent of
  // enableMaintainerrSeasonOverlays, which governs the season posters.
  @Column({ type: 'boolean', default: false })
  public requireAllSeasonsLeaving: boolean;

  // Only consulted when requireAllSeasonsLeaving is on: date the show by the
  // last season to leave (true) or the first (false).
  @Column({ type: 'boolean', default: true })
  public useLatestSeasonDate: boolean;

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;
}

import { getRepository } from '@server/datasource';
import { TmdbResolutionCache } from '@server/entity/TmdbResolutionCache';
import logger from '@server/logger';

export interface ResolutionToStore {
  title: string;
  year: number;
  tmdbId: number | null;
  mediaType: 'movie' | 'tv' | null;
  matchScore: number | null;
}

/** Format Date as 'YYYY-MM-DD HH:MM:SS' for SQLite datetime comparisons */
function sqliteDateTime(date: Date): string {
  return date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '');
}

class TmdbResolutionCacheService {
  private static _instance: TmdbResolutionCacheService;

  public static getInstance(): TmdbResolutionCacheService {
    if (!TmdbResolutionCacheService._instance) {
      TmdbResolutionCacheService._instance = new TmdbResolutionCacheService();
    }
    return TmdbResolutionCacheService._instance;
  }

  static normalizeTitle(title: string): string {
    return title
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // strip accents
      .toLowerCase()
      .replace(/[^\w\s]/g, '') // strip punctuation
      .replace(/\s+/g, ' ')
      .trim();
  }

  static makeLookupKey(title: string, year: number): string {
    return `${TmdbResolutionCacheService.normalizeTitle(title)}::${year}`;
  }

  async lookupBatch(
    items: { title: string; year: number }[]
  ): Promise<Map<string, TmdbResolutionCache>> {
    const repo = getRepository(TmdbResolutionCache);
    const result = new Map<string, TmdbResolutionCache>();
    const keys = items.map((i) =>
      TmdbResolutionCacheService.makeLookupKey(i.title, i.year)
    );
    const uniqueKeys = [...new Set(keys)];
    const now = sqliteDateTime(new Date());

    // Chunk at 500 to stay within SQLite variable limit
    for (let i = 0; i < uniqueKeys.length; i += 500) {
      const chunk = uniqueKeys.slice(i, i + 500);
      const rows = await repo
        .createQueryBuilder('c')
        .where('c.lookupKey IN (:...keys)', { keys: chunk })
        .andWhere('c.expiresAt > :now', { now })
        .getMany();

      for (const row of rows) {
        result.set(row.lookupKey, row);
      }
    }

    return result;
  }

  async storeBatch(results: ResolutionToStore[]): Promise<void> {
    const repo = getRepository(TmdbResolutionCache);

    // Chunk at 200 for upsert
    for (let i = 0; i < results.length; i += 200) {
      const chunk = results.slice(i, i + 200);
      const now = new Date();
      const entities = chunk.map((r) => {
        const ttl = this.calculateTtl(r.matchScore, r.year);
        const expiresAt = new Date(now.getTime() + ttl);
        return new TmdbResolutionCache({
          lookupKey: TmdbResolutionCacheService.makeLookupKey(r.title, r.year),
          originalTitle: r.title,
          year: r.year,
          tmdbId: r.tmdbId,
          mediaType: r.mediaType,
          matchScore: r.matchScore,
          expiresAt,
          updatedAt: now,
        });
      });

      await repo.upsert(entities, { conflictPaths: ['lookupKey'] });
    }
  }

  async cleanup(): Promise<number> {
    const repo = getRepository(TmdbResolutionCache);
    const now = sqliteDateTime(new Date());
    const result = await repo
      .createQueryBuilder()
      .delete()
      .from(TmdbResolutionCache)
      .where('expiresAt < :now', { now })
      .execute();

    const deleted = result.affected ?? 0;
    if (deleted > 0) {
      logger.debug(
        `TMDB resolution cache: cleaned ${deleted} expired entries`,
        {
          label: 'TMDB Resolution Cache',
        }
      );
    }
    return deleted;
  }

  private calculateTtl(score: number | null, year: number): number {
    const DAY = 24 * 60 * 60 * 1000;
    const contentAge = new Date().getFullYear() - year;
    const isOld = contentAge > 2;

    if (score === null) {
      // Negative cache
      return isOld ? 7 * DAY : DAY;
    }
    if (score >= 0.9) {
      return 30 * DAY;
    }
    if (score >= 0.7) {
      return isOld ? 14 * DAY : 7 * DAY;
    }
    if (score >= 0.4) {
      return 3 * DAY;
    }
    // Below 0.4 shouldn't happen (filtered out), but handle gracefully
    return DAY;
  }
}

export default TmdbResolutionCacheService.getInstance();
export { TmdbResolutionCacheService };

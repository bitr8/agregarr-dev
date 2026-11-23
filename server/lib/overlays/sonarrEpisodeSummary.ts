import {
  calculateDaysSince,
  toServerCalendarDate,
} from '@server/utils/dateHelpers';

export type SonarrFinaleType = 'season' | 'series' | 'midseason';

const FINALE_TYPES: readonly string[] = ['season', 'series', 'midseason'];

export interface SonarrEpisodeRow {
  seasonNumber: number;
  episodeNumber: number;
  airDateUtc?: string;
  finaleType?: string | null;
  hasFile?: boolean;
  episodeFileId?: number;
  episodeFile?: { dateAdded?: string };
  scheduledAirDateUtc?: string;
}

/** Air instant for overlays: an episode whose file arrived before its scheduled air time counts from the file's dateAdded. */
export function effectiveAirDateUtc(
  e: Pick<SonarrEpisodeRow, 'airDateUtc' | 'hasFile' | 'episodeFile'>
): string | undefined {
  if (!e.airDateUtc || !e.hasFile) return e.airDateUtc;
  const scheduled = new Date(e.airDateUtc).getTime();
  const added = e.episodeFile?.dateAdded
    ? new Date(e.episodeFile.dateAdded).getTime()
    : NaN;
  if (Number.isNaN(scheduled) || Number.isNaN(added)) return e.airDateUtc;
  if (added >= scheduled) return e.airDateUtc;
  return e.episodeFile?.dateAdded;
}

export function withEffectiveAirDates<T extends SonarrEpisodeRow>(
  episodes: readonly T[]
): T[] {
  return episodes.map((e) => {
    const effective = effectiveAirDateUtc(e);
    return effective === e.airDateUtc
      ? e
      : { ...e, airDateUtc: effective, scheduledAirDateUtc: e.airDateUtc };
  });
}

export type SonarrEpisodeSummary = {
  episodesAiringToday?: number;
  todaySeasonNumber?: number;
  todayEpisodeNumber?: number;
  lastAiredEpisodeDate?: string;
  daysSinceLastAiredEpisode?: number;
  lastAiredSeasonNumber?: number;
  lastAiredEpisodeNumber?: number;
  lastAiredEpisodeCount?: number;
  nextEpisodeCount?: number;
  nextFinaleType?: SonarrFinaleType;
  nextFinaleDate?: string;
  daysUntilNextFinale?: number;
  nextFinaleSeasonNumber?: number;
  nextFinaleEpisodeNumber?: number;
  lastFinaleType?: SonarrFinaleType;
  lastFinaleDate?: string;
  daysSinceLastFinale?: number;
};

export const SONARR_EPISODE_SUMMARY_FIELDS = [
  'episodesAiringToday',
  'todaySeasonNumber',
  'todayEpisodeNumber',
  'lastAiredEpisodeDate',
  'daysSinceLastAiredEpisode',
  'lastAiredSeasonNumber',
  'lastAiredEpisodeNumber',
  'lastAiredEpisodeCount',
  'nextEpisodeCount',
  'nextFinaleType',
  'nextFinaleDate',
  'daysUntilNextFinale',
  'nextFinaleSeasonNumber',
  'nextFinaleEpisodeNumber',
  'lastFinaleType',
  'lastFinaleDate',
  'daysSinceLastFinale',
] as const satisfies readonly (keyof SonarrEpisodeSummary)[];

interface DatedEpisode {
  season: number;
  episode: number;
  airDateUtc: string;
  instant: number;
  day: string;
  daysSince: number;
  aired: boolean;
  finaleType?: SonarrFinaleType;
}

const byAirOrder = (a: DatedEpisode, b: DatedEpisode) =>
  a.instant - b.instant || a.season - b.season || a.episode - b.episode;

/** Show-level episode events from a tracked series' Sonarr list; specials and undated episodes ignored. */
export function summariseSonarrEpisodes(
  episodes: readonly SonarrEpisodeRow[]
): SonarrEpisodeSummary {
  const now = Date.now();
  const byKey = new Map<string, DatedEpisode>();
  for (const e of episodes) {
    if (e.seasonNumber <= 0 || !e.airDateUtc) continue;
    const instant = new Date(e.airDateUtc).getTime();
    if (Number.isNaN(instant)) continue;
    const key = `${e.seasonNumber}:${e.episodeNumber}`;
    const finaleType = FINALE_TYPES.includes(e.finaleType ?? '')
      ? (e.finaleType as SonarrFinaleType)
      : undefined;
    const existing = byKey.get(key);
    if (existing) {
      existing.finaleType ??= finaleType;
      continue;
    }
    const day = toServerCalendarDate(e.airDateUtc);
    byKey.set(key, {
      season: e.seasonNumber,
      episode: e.episodeNumber,
      airDateUtc: e.airDateUtc,
      instant,
      day,
      daysSince: calculateDaysSince(day),
      aired: instant <= now,
      finaleType,
    });
  }
  const dated = [...byKey.values()].sort(byAirOrder);

  const summary: SonarrEpisodeSummary = {};

  const today = dated.filter((e) => e.daysSince === 0);
  summary.episodesAiringToday = today.length;
  if (today[0]) {
    summary.todaySeasonNumber = today[0].season;
    summary.todayEpisodeNumber = today[0].episode;
  }

  const aired = dated.filter((e) => e.aired);
  const last = aired[aired.length - 1];
  if (last) {
    summary.lastAiredEpisodeDate = last.airDateUtc;
    summary.daysSinceLastAiredEpisode = last.daysSince;
    summary.lastAiredSeasonNumber = last.season;
    summary.lastAiredEpisodeNumber = last.episode;
    summary.lastAiredEpisodeCount = aired.filter(
      (e) => e.day === last.day
    ).length;
  }

  const next = dated.find((e) => !e.aired);
  if (next) {
    summary.nextEpisodeCount = dated.filter(
      (e) => !e.aired && e.day === next.day
    ).length;
  }

  const nextFinale = dated.find((e) => e.finaleType && e.daysSince <= 0);
  if (nextFinale) {
    summary.nextFinaleType = nextFinale.finaleType;
    summary.nextFinaleDate = nextFinale.airDateUtc;
    summary.daysUntilNextFinale = Math.abs(nextFinale.daysSince);
    summary.nextFinaleSeasonNumber = nextFinale.season;
    summary.nextFinaleEpisodeNumber = nextFinale.episode;
  }

  const lastFinale = aired.filter((e) => e.finaleType).pop();
  if (lastFinale) {
    summary.lastFinaleType = lastFinale.finaleType;
    summary.lastFinaleDate = lastFinale.airDateUtc;
    summary.daysSinceLastFinale = lastFinale.daysSince;
  }

  return summary;
}

/** One row per season/episode across instances: first instance wins unless a later copy arrived early, then the earliest arrival. */
export function mergeSonarrEpisodes<T extends SonarrEpisodeRow>(
  lists: readonly (readonly T[])[]
): T[] {
  const byKey = new Map<string, T>();
  for (const e of lists.flat()) {
    const key = `${e.seasonNumber}:${e.episodeNumber}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, e);
      continue;
    }
    const a = existing.airDateUtc
      ? new Date(existing.airDateUtc).getTime()
      : NaN;
    const b = e.airDateUtc ? new Date(e.airDateUtc).getTime() : NaN;
    const overrides =
      !!e.scheduledAirDateUtc &&
      (!existing.scheduledAirDateUtc || Number.isNaN(a) || b < a);
    const earlier = overrides ? e : existing;
    byKey.set(key, {
      ...earlier,
      scheduledAirDateUtc:
        existing.scheduledAirDateUtc ?? e.scheduledAirDateUtc,
      finaleType: existing.finaleType ?? e.finaleType,
    });
  }
  return [...byKey.values()];
}

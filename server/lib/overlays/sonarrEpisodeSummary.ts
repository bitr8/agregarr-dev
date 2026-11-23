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
  monitored?: boolean;
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
  nextEpisodeDownloaded?: boolean;
  nextSeasonDownloaded?: boolean;
  nextUndownloadedEpisodeDate?: string;
  daysUntilNextUndownloadedEpisode?: number;
  nextUndownloadedSeasonNumber?: number;
  nextUndownloadedEpisodeNumber?: number;
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
  'nextEpisodeDownloaded',
  'nextSeasonDownloaded',
  'nextUndownloadedEpisodeDate',
  'daysUntilNextUndownloadedEpisode',
  'nextUndownloadedSeasonNumber',
  'nextUndownloadedEpisodeNumber',
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
  hasFile: boolean;
  monitored: boolean;
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
      existing.hasFile ||= !!e.hasFile;
      existing.monitored ||= !!e.monitored;
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
      hasFile: !!e.hasFile,
      monitored: !!e.monitored,
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
    summary.nextEpisodeDownloaded = next.hasFile;
    if (next.episode === 1) summary.nextSeasonDownloaded = next.hasFile;
  }

  const undownloaded = dated.find(
    (e) => e.daysSince <= 0 && e.monitored && !e.hasFile
  );
  if (undownloaded) {
    summary.nextUndownloadedEpisodeDate = undownloaded.airDateUtc;
    summary.daysUntilNextUndownloadedEpisode = Math.abs(undownloaded.daysSince);
    summary.nextUndownloadedSeasonNumber = undownloaded.season;
    summary.nextUndownloadedEpisodeNumber = undownloaded.episode;
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

/** One row per season/episode across instances: the first instance's row, finale type from any, hasFile if any has the file. */
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
    byKey.set(key, {
      ...existing,
      finaleType: existing.finaleType ?? e.finaleType,
      hasFile: existing.hasFile || e.hasFile,
      monitored: existing.monitored || e.monitored,
    });
  }
  return [...byKey.values()];
}

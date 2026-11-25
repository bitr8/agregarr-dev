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
    });
  }
  return [...byKey.values()];
}

export interface NextEpisodeTargets {
  nextEpisode?: { seasonNumber: number; episodeNumber: number };
  nextSeason?: { seasonNumber: number; episodeNumber: number };
}

const episodeKey = (e: { seasonNumber: number; episodeNumber: number }) =>
  `${e.seasonNumber}:${e.episodeNumber}`;

/**
 * Summary across Sonarr instances. hasFile is true if any instance has the file;
 * the undownloaded candidate is picked per instance so a row's date and monitored
 * flag always come from the same instance.
 * The downloaded flags describe the episodes the next-episode / next-season countdowns resolved to.
 */
export function summariseSonarrEpisodeLists(
  lists: readonly (readonly SonarrEpisodeRow[])[],
  targets: NextEpisodeTargets = {}
): SonarrEpisodeSummary {
  const summary = summariseSonarrEpisodes(lists.flat());

  const filed = new Set<string>();
  const known = new Set<string>();
  for (const e of lists.flat()) {
    known.add(episodeKey(e));
    if (e.hasFile) filed.add(episodeKey(e));
  }
  const downloaded = (t: { seasonNumber: number; episodeNumber: number }) =>
    known.has(episodeKey(t)) ? filed.has(episodeKey(t)) : undefined;
  if (targets.nextEpisode) {
    summary.nextEpisodeDownloaded = downloaded(targets.nextEpisode);
  }
  if (targets.nextSeason) {
    summary.nextSeasonDownloaded = downloaded(targets.nextSeason);
  }

  let best:
    | { e: SonarrEpisodeRow; instant: number; daysSince: number }
    | undefined;
  for (const e of lists.flat()) {
    if (
      e.seasonNumber <= 0 ||
      !e.airDateUtc ||
      !e.monitored ||
      filed.has(episodeKey(e))
    ) {
      continue;
    }
    const instant = new Date(e.airDateUtc).getTime();
    if (Number.isNaN(instant)) continue;
    const daysSince = calculateDaysSince(toServerCalendarDate(e.airDateUtc));
    if (daysSince > 0) continue;
    const order = best
      ? instant - best.instant ||
        e.seasonNumber - best.e.seasonNumber ||
        e.episodeNumber - best.e.episodeNumber
      : -1;
    if (order < 0) best = { e, instant, daysSince };
  }
  if (best) {
    summary.nextUndownloadedEpisodeDate = best.e.airDateUtc;
    summary.daysUntilNextUndownloadedEpisode = Math.abs(best.daysSince);
    summary.nextUndownloadedSeasonNumber = best.e.seasonNumber;
    summary.nextUndownloadedEpisodeNumber = best.e.episodeNumber;
  }

  return summary;
}

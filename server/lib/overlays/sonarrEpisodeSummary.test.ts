process.env.TZ = 'Australia/Sydney';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SONARR_EPISODE_SUMMARY_FIELDS,
  summariseSonarrEpisodes,
  type SonarrEpisodeRow,
} from './sonarrEpisodeSummary';

// Rows copied from Sonarr 5.0.0.2997 GET /api/v3/episode (22/11/2026).
const yellowjackets: SonarrEpisodeRow[] = [
  {
    seasonNumber: 0,
    episodeNumber: 1,
    airDateUtc: '2026-11-22T02:00:00Z',
    finaleType: null,
  },
  {
    seasonNumber: 3,
    episodeNumber: 10,
    airDateUtc: '2025-04-14T01:00:00Z',
    finaleType: 'season',
  },
  {
    seasonNumber: 4,
    episodeNumber: 1,
    airDateUtc: '2026-11-23T02:00:00Z',
    finaleType: null,
  },
  {
    seasonNumber: 4,
    episodeNumber: 2,
    airDateUtc: '2026-11-30T02:00:00Z',
    finaleType: null,
  },
  {
    seasonNumber: 4,
    episodeNumber: 10,
    airDateUtc: '2027-01-25T02:00:00Z',
    finaleType: 'series',
  },
];

const bladeRunner2099: SonarrEpisodeRow[] = Array.from(
  { length: 8 },
  (_, i) => ({
    seasonNumber: 1,
    episodeNumber: i + 1,
    airDateUtc: '2026-11-25T08:00:00Z',
    finaleType: i === 7 ? 'series' : null,
  })
);

const outlanderBomS2: SonarrEpisodeRow[] = [
  { seasonNumber: 2, episodeNumber: 8, airDateUtc: '2026-11-07T01:00:00Z' },
  { seasonNumber: 2, episodeNumber: 9, airDateUtc: '2026-11-21T01:00:00Z' },
  {
    seasonNumber: 2,
    episodeNumber: 10,
    airDateUtc: '2026-11-28T01:00:00Z',
    finaleType: 'season',
  },
];

const abbottS6: SonarrEpisodeRow[] = [
  { seasonNumber: 6, episodeNumber: 6, airDateUtc: '2026-11-12T01:30:00Z' },
  { seasonNumber: 6, episodeNumber: 7, airDateUtc: '2026-12-03T01:30:00Z' },
  {
    seasonNumber: 6,
    episodeNumber: 8,
    airDateUtc: '2026-12-10T01:30:00Z',
    finaleType: 'midseason',
  },
  { seasonNumber: 6, episodeNumber: 9, airDateUtc: '2027-01-14T01:30:00Z' },
];

// Sonarr lists episodes out of order; S3 has its finale flag on E9 of 19.
const americanDadS3: SonarrEpisodeRow[] = [
  { seasonNumber: 3, episodeNumber: 10, airDateUtc: '2007-01-08T03:00:00Z' },
  { seasonNumber: 3, episodeNumber: 11, airDateUtc: '2007-01-29T03:00:00Z' },
  { seasonNumber: 3, episodeNumber: 8, airDateUtc: '2006-12-11T03:00:00Z' },
  {
    seasonNumber: 3,
    episodeNumber: 9,
    airDateUtc: '2006-12-18T03:00:00Z',
    finaleType: 'season',
  },
];

const at = (iso: string) => vi.setSystemTime(new Date(iso));

describe('summariseSonarrEpisodes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps TODAY for the rest of the airing day while the next countdown moves on', () => {
    // Tue 24/11 20:00 AEDT, then the following Tuesday.
    const eps: SonarrEpisodeRow[] = [
      { seasonNumber: 1, episodeNumber: 1, airDateUtc: '2026-11-24T09:00:00Z' },
      { seasonNumber: 1, episodeNumber: 2, airDateUtc: '2026-12-01T09:00:00Z' },
    ];
    at('2026-11-24T10:00:00Z'); // 21:00 AEDT
    expect(summariseSonarrEpisodes(eps)).toMatchObject({
      episodesAiringToday: 1,
      todaySeasonNumber: 1,
      todayEpisodeNumber: 1,
      daysSinceLastAiredEpisode: 0,
      lastAiredEpisodeDate: '2026-11-24T09:00:00Z',
      lastAiredSeasonNumber: 1,
      lastAiredEpisodeNumber: 1,
      lastAiredEpisodeCount: 1,
      nextEpisodeCount: 1,
    });

    at('2026-11-24T13:01:00Z'); // Wed 00:01 AEDT
    const after = summariseSonarrEpisodes(eps);
    expect(after.episodesAiringToday).toBe(0);
    expect(after.todaySeasonNumber).toBeUndefined();
    expect(after.todayEpisodeNumber).toBeUndefined();
    expect(after.daysSinceLastAiredEpisode).toBe(1);
  });

  it('counts an episode airing later today before airtime too', () => {
    at('2026-11-22T21:00:00Z'); // Mon 23/11 08:00 AEDT
    const s = summariseSonarrEpisodes(yellowjackets);
    expect(s.episodesAiringToday).toBe(1);
    expect(s.todaySeasonNumber).toBe(4);
    expect(s.todayEpisodeNumber).toBe(1);
    expect(s.lastAiredSeasonNumber).toBe(3);
    expect(s.lastAiredEpisodeNumber).toBe(10);
  });

  it('rolls the day at local midnight across the DST change (04/10/2026)', () => {
    // Sat 03/10 23:30 AEST = 13:30Z; clocks go forward at 02:00 on 04/10.
    const eps: SonarrEpisodeRow[] = [
      { seasonNumber: 1, episodeNumber: 1, airDateUtc: '2026-10-03T13:30:00Z' },
      { seasonNumber: 1, episodeNumber: 2, airDateUtc: '2026-10-04T09:00:00Z' },
    ];
    at('2026-10-03T13:45:00Z'); // Sat 23:45 AEST
    expect(summariseSonarrEpisodes(eps)).toMatchObject({
      episodesAiringToday: 1,
      todayEpisodeNumber: 1,
      daysSinceLastAiredEpisode: 0,
    });
    at('2026-10-03T14:01:00Z'); // Sun 00:01 AEST
    expect(summariseSonarrEpisodes(eps)).toMatchObject({
      episodesAiringToday: 1,
      todayEpisodeNumber: 2,
      daysSinceLastAiredEpisode: 1,
    });
    at('2026-10-04T12:59:00Z'); // Sun 23:59 AEDT
    expect(summariseSonarrEpisodes(eps)).toMatchObject({
      episodesAiringToday: 1,
      lastAiredEpisodeNumber: 2,
      daysSinceLastAiredEpisode: 0,
    });
    at('2026-10-04T13:01:00Z'); // Mon 00:01 AEDT
    expect(summariseSonarrEpisodes(eps)).toMatchObject({
      episodesAiringToday: 0,
      daysSinceLastAiredEpisode: 1,
    });
  });

  it('counts a batch drop as one day of 8 episodes', () => {
    at('2026-11-24T12:00:00Z'); // 23:00 AEDT the night before
    expect(summariseSonarrEpisodes(bladeRunner2099)).toMatchObject({
      episodesAiringToday: 0,
      nextEpisodeCount: 8,
    });
    expect(
      summariseSonarrEpisodes(bladeRunner2099).lastAiredEpisodeDate
    ).toBeUndefined();

    at('2026-11-25T10:00:00Z'); // 21:00 AEDT on the day
    expect(summariseSonarrEpisodes(bladeRunner2099)).toMatchObject({
      episodesAiringToday: 8,
      todayEpisodeNumber: 1,
      lastAiredEpisodeCount: 8,
      lastAiredEpisodeNumber: 8,
      daysSinceLastAiredEpisode: 0,
    });
    expect(
      summariseSonarrEpisodes(bladeRunner2099).nextEpisodeCount
    ).toBeUndefined();
  });

  it('never counts specials', () => {
    at('2026-11-22T03:00:00Z'); // 22/11 14:00 AEDT, an hour after S0E1 aired
    const s = summariseSonarrEpisodes(yellowjackets);
    expect(s.episodesAiringToday).toBe(0);
    expect(s.lastAiredSeasonNumber).toBe(3);
    expect(s.lastAiredEpisodeNumber).toBe(10);
  });

  it('never treats an undated episode as aired or today', () => {
    at('2026-11-24T10:00:00Z');
    const s = summariseSonarrEpisodes([
      { seasonNumber: 24, episodeNumber: 1 },
      { seasonNumber: 24, episodeNumber: 2, airDateUtc: undefined },
    ]);
    expect(s.episodesAiringToday).toBe(0);
    expect(s.lastAiredEpisodeDate).toBeUndefined();
    expect(s.daysSinceLastAiredEpisode).toBeUndefined();
    expect(s.nextEpisodeCount).toBeUndefined();
  });

  it('reads the latest aired episode regardless of list order', () => {
    at('2026-11-22T03:00:00Z');
    expect(summariseSonarrEpisodes(americanDadS3)).toMatchObject({
      lastAiredSeasonNumber: 3,
      lastAiredEpisodeNumber: 11,
      lastAiredEpisodeDate: '2007-01-29T03:00:00Z',
      lastFinaleType: 'season',
      lastFinaleDate: '2006-12-18T03:00:00Z',
    });
  });

  it('counts an episode listed by two Sonarr instances once', () => {
    at('2026-11-24T10:00:00Z');
    const ep = {
      seasonNumber: 1,
      episodeNumber: 1,
      airDateUtc: '2026-11-24T09:00:00Z',
    };
    expect(summariseSonarrEpisodes([ep, { ...ep }]).episodesAiringToday).toBe(
      1
    );
  });
});

describe('summariseSonarrEpisodes finales', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts down to the next finale and reads 0 all of finale day', () => {
    at('2026-11-22T03:00:00Z');
    expect(summariseSonarrEpisodes(outlanderBomS2)).toMatchObject({
      nextFinaleType: 'season',
      nextFinaleDate: '2026-11-28T01:00:00Z',
      daysUntilNextFinale: 6,
      nextFinaleSeasonNumber: 2,
      nextFinaleEpisodeNumber: 10,
    });

    at('2026-11-27T14:00:00Z'); // 28/11 01:00 AEDT, before the 12:00 airtime
    expect(summariseSonarrEpisodes(outlanderBomS2).daysUntilNextFinale).toBe(0);
    expect(
      summariseSonarrEpisodes(outlanderBomS2).lastFinaleType
    ).toBeUndefined();

    at('2026-11-28T09:00:00Z'); // 28/11 20:00 AEDT, after airtime
    expect(summariseSonarrEpisodes(outlanderBomS2)).toMatchObject({
      daysUntilNextFinale: 0,
      nextFinaleEpisodeNumber: 10,
      lastFinaleType: 'season',
      daysSinceLastFinale: 0,
    });

    at('2026-11-28T13:01:00Z'); // 29/11 00:01 AEDT
    const s = summariseSonarrEpisodes(outlanderBomS2);
    expect(s.nextFinaleType).toBeUndefined();
    expect(s.daysUntilNextFinale).toBeUndefined();
    expect(s.daysSinceLastFinale).toBe(1);
  });

  it('leaves finale fields absent when no episode is flagged', () => {
    at('2026-11-22T03:00:00Z');
    const s = summariseSonarrEpisodes(outlanderBomS2.slice(0, 2));
    for (const f of [
      'nextFinaleType',
      'nextFinaleDate',
      'daysUntilNextFinale',
      'lastFinaleType',
      'lastFinaleDate',
      'daysSinceLastFinale',
    ] as const) {
      expect(s[f]).toBeUndefined();
    }
    expect(s.lastAiredEpisodeNumber).toBe(9);
  });

  it('reads a midseason flag as midseason', () => {
    at('2026-11-22T03:00:00Z');
    expect(summariseSonarrEpisodes(abbottS6)).toMatchObject({
      nextFinaleType: 'midseason',
      nextFinaleEpisodeNumber: 8,
      daysUntilNextFinale: 18,
    });
  });

  it('picks the earliest upcoming finale across seasons', () => {
    at('2026-11-22T03:00:00Z');
    expect(summariseSonarrEpisodes(yellowjackets)).toMatchObject({
      nextFinaleType: 'series',
      nextFinaleSeasonNumber: 4,
      lastFinaleType: 'season',
      lastFinaleDate: '2025-04-14T01:00:00Z',
    });
  });

  it('keeps a finale flag only the second Sonarr instance has', () => {
    at('2026-11-22T03:00:00Z');
    const ep = {
      seasonNumber: 2,
      episodeNumber: 10,
      airDateUtc: '2026-11-28T01:00:00Z',
    };
    expect(
      summariseSonarrEpisodes([ep, { ...ep, finaleType: 'season' }])
        .nextFinaleType
    ).toBe('season');
  });

  it('ignores finale types Sonarr may add later', () => {
    at('2026-11-22T03:00:00Z');
    const s = summariseSonarrEpisodes([
      {
        seasonNumber: 1,
        episodeNumber: 1,
        airDateUtc: '2026-12-01T00:00:00Z',
        finaleType: 'mystery',
      },
    ]);
    expect(s.nextFinaleType).toBeUndefined();
  });
});

describe('SONARR_EPISODE_SUMMARY_FIELDS', () => {
  it('lists every field the summary can produce', () => {
    vi.useFakeTimers();
    at('2026-11-28T09:00:00Z');
    const produced = Object.keys(
      summariseSonarrEpisodes([
        ...outlanderBomS2,
        ...yellowjackets,
        {
          seasonNumber: 5,
          episodeNumber: 1,
          airDateUtc: '2026-11-28T10:00:00Z',
          monitored: true,
        },
      ])
    );
    vi.useRealTimers();
    expect([...produced].sort()).toEqual(
      [...SONARR_EPISODE_SUMMARY_FIELDS].sort()
    );
  });
});

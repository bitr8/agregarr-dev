import type { PlexMetadata } from '@server/api/plexapi';
import { EpisodeMediaCache } from '@server/entity/EpisodeMediaCache';
import { calculateOverlayInputHash } from '@server/utils/metadataHashing';
import { describe, expect, it, vi } from 'vitest';
import { EpisodeMediaAggregator } from './EpisodeMediaAggregator';
import {
  entityFromEpisode,
  episodeFromRow,
  EpisodeMediaCacheService,
} from './EpisodeMediaCacheService';
import type { EpisodeMediaInfo } from './episodeMediaTypes';
import { resolveFetchedEpisodeDetail } from './PlexEpisodeMediaScanner';
import streamFixtures from './__fixtures__/plexEpisodeStreams.json';

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));

function episode(
  showRatingKey: string,
  ratingKey: string,
  overrides: Partial<EpisodeMediaInfo> = {}
): EpisodeMediaInfo {
  return {
    ratingKey,
    showRatingKey,
    seasonRatingKey: `${showRatingKey}-s1`,
    seasonNumber: 1,
    episodeNumber: 1,
    resolution: '1080',
    hdr: false,
    dolbyVision: false,
    hdr10Plus: false,
    videoCodec: 'hevc',
    audioCodec: 'eac3',
    audioChannels: 6,
    bitDepth: 10,
    mediaHash: `hash-${ratingKey}`,
    hasStreamDetail: false,
    ...overrides,
  };
}

function scan(fixture: keyof typeof streamFixtures): EpisodeMediaInfo {
  return resolveFetchedEpisodeDetail(
    episode('show', 'ep'),
    streamFixtures[fixture] as unknown as PlexMetadata
  );
}

const aggregator = new EpisodeMediaAggregator();

describe('episode stream extraction from real Plex streams', () => {
  it('reads HDR10+ and Atmos on a non-first audio track', () => {
    const ep = scan('hdr10plus_dv_atmos_third_track');
    expect(ep.hasStreamDetail).toBe(true);
    expect(ep.hdr10Plus).toBe(true);
    expect(ep.dolbyVision).toBe(true);
    expect(ep.hdr).toBe(true);
    expect(ep.audioProfile).toBe('plus_atmos');
  });

  it('does not call an AAC track Atmos whatever the filename says', () => {
    const ep = scan('aac_atmosphere_filename');
    expect(ep.hdr10Plus).toBe(false);
    expect(ep.audioProfile).toBe('aac');
  });
});

describe('show rollup of audioProfile and hdr10Plus', () => {
  it('counts an HDR10+ half as true, a minority as false', () => {
    const eps = [
      ...[1, 2, 3, 4].map((n) =>
        episode('half', `h${n}`, { hdr10Plus: n <= 2 })
      ),
      ...Array.from({ length: 10 }, (_, n) =>
        episode('few', `f${n}`, { hdr10Plus: n === 0 })
      ),
    ];
    const result = aggregator.aggregateByShow(eps);
    expect(result.get('half')!.hdr10Plus).toBe(true);
    expect(result.get('few')!.hdr10Plus).toBe(false);
  });

  it('ignores episodes with no detected profile when voting', () => {
    const result = aggregator.aggregateByShow([
      episode('s', 'a', { audioProfile: 'truehd_atmos' }),
      episode('s', 'b', { audioProfile: undefined }),
      episode('s', 'c', {
        audioProfile: null as unknown as string | undefined,
      }),
      episode('s', 'd', {
        audioProfile: null as unknown as string | undefined,
      }),
      episode('s', 'e'),
      episode('s', 'f'),
    ]);
    expect(result.get('s')!.audioProfile).toBe('truehd_atmos');
  });

  it('leaves audioProfile undefined when no episode has one', () => {
    const result = aggregator.aggregateByShow([episode('s', 'a')]);
    expect(result.get('s')!.audioProfile).toBeUndefined();
    expect(result.get('s')!.hdr10Plus).toBe(false);
  });

  it('breaks a tie by format rank, not episode order', () => {
    const atmos = episode('s', 'a', { audioProfile: 'plus_atmos' });
    const plus = episode('s', 'b', { audioProfile: 'plus' });
    expect(
      aggregator.aggregateByShow([atmos, plus]).get('s')!.audioProfile
    ).toBe('plus_atmos');
    expect(
      aggregator.aggregateByShow([plus, atmos]).get('s')!.audioProfile
    ).toBe('plus_atmos');
  });

  it('keeps the most common token when it outnumbers a better one', () => {
    const result = aggregator.aggregateByShow([
      episode('s', 'a', { audioProfile: 'plus_atmos' }),
      episode('s', 'b', { audioProfile: 'plus' }),
      episode('s', 'c', { audioProfile: 'plus' }),
    ]);
    expect(result.get('s')!.audioProfile).toBe('plus');
  });
});

describe('episode media cache round trip', () => {
  const now = new Date('2026-11-09T00:00:00Z');

  function roundTrip(ep: EpisodeMediaInfo): EpisodeMediaInfo {
    const entity = entityFromEpisode('srv', '3', ep, now);
    // Mirror what SQLite hands back: undefined columns come back as null.
    const row = Object.assign(new EpisodeMediaCache(), entity, {
      dolbyVisionProfile: entity.dolbyVisionProfile ?? null,
    });
    return episodeFromRow(row as EpisodeMediaCache);
  }

  it('persists a missing audioProfile as explicit null', () => {
    const entity = entityFromEpisode('srv', '3', episode('s', 'a'), now);
    expect(entity.audioProfile).toBeNull();
    expect(entity.hdr10Plus).toBe(false);
  });

  it('loads back the same fields it saved', () => {
    const withProfile = episode('s', 'a', {
      audioProfile: 'truehd_atmos',
      hdr10Plus: true,
      addedAt: 1700000000,
    });
    expect(roundTrip(withProfile)).toEqual({
      ...withProfile,
      dolbyVisionProfile: undefined,
    });
    expect(roundTrip(episode('s', 'b')).audioProfile).toBeUndefined();
  });

  it('gives the same overlay hash from a fresh scan and from cached rows', () => {
    const fresh = [
      scan('hdr10plus_dv_atmos_third_track'),
      { ...scan('aac_atmosphere_filename'), ratingKey: 'ep2' },
      episode('show', 'ep3'),
    ];
    const cached = fresh.map(roundTrip);
    const usedFields = new Set([
      'audioProfile',
      'hdr10Plus',
      'dolbyVision',
      'dolbyVisionProfile',
    ]);
    const hash = (eps: EpisodeMediaInfo[]) =>
      calculateOverlayInputHash({
        templateIds: [1],
        templateData: [],
        usedFields,
        context: { ...aggregator.aggregateByShow(eps).get('show')! },
      });
    expect(aggregator.aggregateByShow(cached)).toEqual(
      aggregator.aggregateByShow(fresh)
    );
    expect(hash(cached)).toBe(hash(fresh));
  });
});

describe('which episodes need a stream detail fetch', () => {
  const service = new EpisodeMediaCacheService();
  const detailed = (rk: string) =>
    episode('show', rk, { hasStreamDetail: true });

  it('ignores cached rows for episodes Plex no longer has', () => {
    const cached = [detailed('a'), detailed('b'), episode('show', 'gone')];
    const fresh = [episode('show', 'a'), episode('show', 'b')];
    expect(service.getKeysNeedingStreamDetail(cached, fresh)).toEqual(
      new Set()
    );
  });

  it('fetches only new, changed or undetailed current episodes', () => {
    const cached = [
      detailed('kept'),
      detailed('changed'),
      episode('show', 'lightweight'),
      episode('show', 'gone'),
    ];
    const fresh = [
      episode('show', 'kept'),
      episode('show', 'changed', { mediaHash: 'new-hash' }),
      episode('show', 'lightweight'),
      episode('show', 'new'),
    ];
    expect(service.getKeysNeedingStreamDetail(cached, fresh)).toEqual(
      new Set(['changed', 'lightweight', 'new'])
    );
  });
});

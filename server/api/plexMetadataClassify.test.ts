import type { PlexMetadata } from '@server/api/plexapi';
import {
  classifyCollectionKey,
  classifyPlexMetadataResponse,
  isPlexNotFoundError,
} from '@server/api/plexMetadataClassify';
import { describe, expect, it } from 'vitest';

const meta = (type: string, ratingKey = '398348'): PlexMetadata =>
  ({
    ratingKey,
    type,
    title: 'x',
    guid: '',
    Guid: [],
  } as unknown as PlexMetadata);

/**
 * These classifiers gate a DESTRUCTIVE cleanup (a 'not_found' verdict deletes a
 * season's stored base poster + tracking row). The tests lock in that only a
 * genuine, unambiguous absence yields 'not_found'; every ambiguous case is
 * 'error'.
 */
describe('isPlexNotFoundError', () => {
  it('classifies a real plex-api 404 message as not-found', () => {
    // Exact shape verified live against nostromo's Plex.
    expect(
      isPlexNotFoundError(
        'Plex Server didnt respond with a valid 2xx status code, response code: 404'
      )
    ).toBe(true);
  });

  it('does NOT treat non-404 statuses as not-found', () => {
    for (const code of ['500', '401', '403', '502', '400']) {
      expect(
        isPlexNotFoundError(
          `Plex Server didnt respond with a valid 2xx status code, response code: ${code}`
        )
      ).toBe(false);
    }
  });

  it('does NOT misread a ratingKey containing 404 digits on an unrelated failure', () => {
    // A 5xx on a ratingKey like 40412 / 14045 must never read as a deletion.
    expect(
      isPlexNotFoundError(
        'GET /library/metadata/40412 failed, response code: 500'
      )
    ).toBe(false);
    expect(
      isPlexNotFoundError(
        'GET /library/metadata/14045 failed, response code: 503'
      )
    ).toBe(false);
  });

  it('parses the response code, not URL noise, when both are present', () => {
    expect(
      isPlexNotFoundError(
        'GET /library/metadata/40412 failed, response code: 404'
      )
    ).toBe(true);
  });

  it('does not substring-match 404 inside a longer malformed code', () => {
    expect(isPlexNotFoundError('response code: 4040')).toBe(false);
    expect(isPlexNotFoundError('response code: 14045')).toBe(false);
  });

  it('treats transport errors with no status code as not-a-404', () => {
    expect(
      isPlexNotFoundError('connect ECONNREFUSED 192.168.1.178:32400')
    ).toBe(false);
    expect(isPlexNotFoundError('socket hang up')).toBe(false);
    expect(isPlexNotFoundError('')).toBe(false);
  });
});

describe('classifyPlexMetadataResponse', () => {
  it('returns ok with the metadata item for a well-formed container', () => {
    const result = classifyPlexMetadataResponse({
      MediaContainer: { Metadata: [{ ratingKey: '25417', type: 'season' }] },
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.meta.ratingKey).toBe('25417');
    }
  });

  it('returns not_found for a well-formed container with no items', () => {
    expect(classifyPlexMetadataResponse({ MediaContainer: {} }).status).toBe(
      'not_found'
    );
    expect(
      classifyPlexMetadataResponse({ MediaContainer: { Metadata: [] } }).status
    ).toBe('not_found');
  });

  it('returns error (never not_found) for a non-Plex 2xx body', () => {
    // Reverse-proxy / auth / captive-portal responses must not read as deletion.
    expect(classifyPlexMetadataResponse('<html>login</html>').status).toBe(
      'error'
    );
    expect(classifyPlexMetadataResponse(Buffer.from('<html>')).status).toBe(
      'error'
    );
    expect(classifyPlexMetadataResponse({}).status).toBe('error');
    expect(classifyPlexMetadataResponse(null).status).toBe('error');
    expect(classifyPlexMetadataResponse(undefined).status).toBe('error');
    expect(classifyPlexMetadataResponse(42).status).toBe('error');
  });
});

/**
 * classifyCollectionKey decides whether a collection sync may discard a stored
 * ratingKey after a WRITE to it returned 404. Only 'absent' and
 * 'not-a-collection' are actionable. A collection whose section-scoped title
 * PUT 404s (because the section is wrong) reads back as 'present' and must be
 * left completely alone — that path previously deleted it.
 */
describe('classifyCollectionKey', () => {
  it('reports a real collection as present', () => {
    expect(
      classifyCollectionKey({ status: 'ok', meta: meta('collection') })
    ).toBe('present');
  });

  it('reports a confirmed absence', () => {
    expect(classifyCollectionKey({ status: 'not_found' })).toBe('absent');
  });

  it('never reports absent for an ambiguous read', () => {
    // 5xx, auth failure, captive portal, socket hang up.
    expect(classifyCollectionKey({ status: 'error' })).toBe('ambiguous');
  });

  it('reports a key pointing at a media item as not-a-collection', () => {
    // /library/collections/{key}/prefs 404s for a movie ratingKey while the
    // movie itself reads back fine. Clearing the key is right; deleting the
    // movie is not.
    for (const type of ['movie', 'show', 'season', 'episode']) {
      expect(classifyCollectionKey({ status: 'ok', meta: meta(type) })).toBe(
        'not-a-collection'
      );
    }
  });

  it('treats an unrecognised or missing type as ambiguous, never actionable', () => {
    // If Plex ever renames the literal, we must not decide the key is junk and
    // recreate a duplicate over the top of a healthy collection.
    for (const type of ['Collection', 'playlist', 'artist', '']) {
      expect(classifyCollectionKey({ status: 'ok', meta: meta(type) })).toBe(
        'ambiguous'
      );
    }
    expect(
      classifyCollectionKey({
        status: 'ok',
        meta: { ratingKey: '1' } as unknown as PlexMetadata,
      })
    ).toBe('ambiguous');
  });

  it('treats a healthy collection as present even when a write just 404d', () => {
    // Reproduces the fork#5 shape: PUT /library/sections/99/all?type=18&id=X
    // returns 404 because section 99 does not exist, though X is populated.
    const state = classifyCollectionKey({
      status: 'ok',
      meta: meta('collection', '181765'),
    });
    expect(state).toBe('present');
    expect(state).not.toBe('absent');
  });
});

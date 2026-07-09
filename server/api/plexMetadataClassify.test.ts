import {
  classifyPlexMetadataResponse,
  isPlexNotFoundError,
} from '@server/api/plexMetadataClassify';
import { describe, expect, it } from 'vitest';

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

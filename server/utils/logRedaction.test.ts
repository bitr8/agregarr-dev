import { afterEach, describe, expect, it } from 'vitest';

import {
  clearLogSecretsForTesting,
  collectSecretValues,
  registerLogSecrets,
  scrubSecrets,
} from './logRedaction';

describe('scrubSecrets', () => {
  afterEach(() => {
    clearLogSecretsForTesting();
  });

  describe('query param redaction', () => {
    it('redacts X-Plex-Token in URLs', () => {
      const result = scrubSecrets(
        'GET http://192.168.1.10:32400/library/sections?X-Plex-Token=abc123XYZtoken'
      );
      expect(result).not.toContain('abc123XYZtoken');
      expect(result).toContain('X-Plex-Token=[redacted]');
    });

    it('redacts api_key, apikey and accessToken params', () => {
      const result = scrubSecrets(
        'url?api_key=secret1&apikey=secret2&accessToken=secret3&page=2'
      );
      expect(result).toBe(
        'url?api_key=[redacted]&apikey=[redacted]&accessToken=[redacted]&page=2'
      );
    });

    it('redacts bare key= as a standalone param only', () => {
      expect(scrubSecrets('https://api.example.com/v1?key=AIzaSyABC')).toBe(
        'https://api.example.com/v1?key=[redacted]'
      );
    });
  });

  describe('supportability: diagnostic fields must survive', () => {
    it('preserves ratingKey, parentRatingKey and grandparentRatingKey', () => {
      const line =
        'Synced item ratingKey=12345 parentRatingKey=678 grandparentRatingKey=90';
      expect(scrubSecrets(line)).toBe(line);
    });

    it('preserves JSON "key" path properties from Plex metadata', () => {
      const line = '{"key":"/library/metadata/123","ratingKey":"123"}';
      expect(scrubSecrets(line)).toBe(line);
    });

    it('preserves sectionKey and sortKey params', () => {
      const line = 'fetch sectionKey=3 sortKey=titleSort';
      expect(scrubSecrets(line)).toBe(line);
    });
  });

  describe('JSON property redaction', () => {
    it('redacts credential-named JSON string properties', () => {
      const result = scrubSecrets(
        '{"plexToken":"tok123","apiKey":"key456","clientSecret":"sec789","title":"FROM"}'
      );
      expect(result).toBe(
        '{"plexToken":"[redacted]","apiKey":"[redacted]","clientSecret":"[redacted]","title":"FROM"}'
      );
    });

    it('keeps the output parseable as JSON', () => {
      const result = scrubSecrets(
        JSON.stringify({
          url: 'http://plex:32400/hubs?X-Plex-Token=abcdef123456', // gitleaks:allow
          apiKey: 'with "escaped\\" quotes',
          ratingKey: '42',
        })
      );
      expect(() => JSON.parse(result)).not.toThrow();
      expect(JSON.parse(result).ratingKey).toBe('42');
    });

    it('handles values with escaped quotes without eating siblings', () => {
      const result = scrubSecrets('{"password":"a\\"b","next":"keep"}');
      expect(result).toBe('{"password":"[redacted]","next":"keep"}');
    });
  });

  describe('escaped JSON (stringified body inside a message)', () => {
    it('redacts credentials behind one level of JSON escaping', () => {
      // winston json() escapes inner quotes when a stringified body is part
      // of the message - the machinelogs leak vector from review finding #1.
      const line = JSON.stringify({
        message: 'response: ' + JSON.stringify({ plexToken: 'SECRETABC12345' }), // gitleaks:allow
        level: 'debug',
      });
      const result = scrubSecrets(line);
      expect(result).not.toContain('SECRETABC12345');
      expect(() => JSON.parse(result)).not.toThrow();
    });
  });

  describe('headers and auth schemes', () => {
    it('redacts Authorization bearer values', () => {
      const result = scrubSecrets(
        'headers: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'
      );
      expect(result).toContain('Bearer [redacted]');
      expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });

    it('does not mangle prose containing the word Bearer', () => {
      const line = 'Bearer of the news was the sync job';
      expect(scrubSecrets(line)).toBe(line);
    });

    it('redacts Basic auth values', () => {
      const result = scrubSecrets('Authorization: Basic dXNlcjpwYXNzd29yZA==');
      expect(result).toBe('Authorization: Basic [redacted]');
    });

    it('redacts raw colon-separated credential headers', () => {
      const result = scrubSecrets('X-Plex-Token: abcdef123456 timeout=5000'); // gitleaks:allow
      expect(result).toBe('X-Plex-Token: [redacted] timeout=5000');
    });

    it('redacts cookie values in JSON header dumps', () => {
      const result = scrubSecrets('{"cookie":"agregarr.sid=s%3Aabc123"}');
      expect(result).toBe('{"cookie":"[redacted]"}');
    });
  });

  describe('URL userinfo credentials', () => {
    it('redacts user:password@host forms', () => {
      const result = scrubSecrets(
        'connecting to redis://admin:hunter2pass@redis:6379/0'
      );
      expect(result).toBe(
        'connecting to redis://admin:[redacted]@redis:6379/0'
      );
    });

    it('leaves credential-free URLs alone', () => {
      const line = 'GET http://192.168.1.178:32400/library/sections';
      expect(scrubSecrets(line)).toBe(line);
    });
  });

  describe('registered secret values', () => {
    it('redacts registered values anywhere in the line', () => {
      registerLogSecrets(['s3cretPlexTokenValue']);
      const result = scrubSecrets(
        'yt-dlp exited: http://plex/video?t=s3cretPlexTokenValue raw s3cretPlexTokenValue'
      );
      expect(result).not.toContain('s3cretPlexTokenValue');
    });

    it('ignores short values that would shred ordinary log content', () => {
      registerLogSecrets(['test', '', null, undefined]);
      expect(scrubSecrets('test run for testing')).toBe('test run for testing');
    });

    it('does not treat secrets as regex', () => {
      registerLogSecrets(['a+b(c)?.*d$end']);
      expect(scrubSecrets('value is a+b(c)?.*d$end here')).toBe(
        'value is [redacted] here'
      );
    });
  });

  describe('robustness', () => {
    it('returns falsy input unchanged', () => {
      expect(scrubSecrets('')).toBe('');
    });

    it('does not backtrack on backslash runs without a closing quote', () => {
      // ReDoS regression: escaped-JSON value followed by a long backslash
      // run and no terminating \" (truncated line / Windows path).
      const hostile =
        '{"message":"\\"secret\\":\\"C:' + '\\\\'.repeat(200) + ' truncated';
      const start = performance.now();
      scrubSecrets(hostile);
      expect(performance.now() - start).toBeLessThan(50);
    });

    it('handles a large single-line payload quickly', () => {
      const big =
        '{"items":[' +
        Array.from(
          { length: 5000 },
          (_, i) =>
            `{"ratingKey":"${i}","url":"http://p:32400/m/${i}?X-Plex-Token=tokenvalue${i}"}`
        ).join(',') +
        ']}';
      const start = performance.now();
      const result = scrubSecrets(big);
      const elapsed = performance.now() - start;
      expect(result).not.toContain('tokenvalue42');
      expect(result).toContain('"ratingKey":"42"');
      expect(elapsed).toBeLessThan(250);
    });
  });
});

describe('collectSecretValues', () => {
  it('collects credential-named string fields recursively', () => {
    const values = collectSecretValues({
      main: { apiKey: 'mainApiKey123' }, // gitleaks:allow
      radarr: [{ apiKey: 'radarrKey456', hostname: 'radarr' }],
      trakt: { clientSecret: 'traktSecret789', tokenExpiresAt: 12345 },
      plex: { ip: '192.168.1.10', libraries: [] },
    });
    expect(values).toEqual(
      expect.arrayContaining([
        'mainApiKey123',
        'radarrKey456',
        'traktSecret789',
      ])
    );
    expect(values).toHaveLength(3);
  });

  it('skips non-string credential fields', () => {
    expect(collectSecretValues({ tokenExpiresAt: 999 })).toEqual([]);
  });
});

import {
  extractContentAddressedPosterRef,
  extractThumbId,
  posterUrlsMatch,
} from '@server/utils/posterUrlHelpers';
import { describe, expect, it } from 'vitest';

const TOKEN = 'X-Plex-Token=abc123';

describe('extractContentAddressedPosterRef', () => {
  it('returns a bare upload reference unchanged', () => {
    expect(extractContentAddressedPosterRef('upload://posters/abc123')).toBe(
      'upload://posters/abc123'
    );
  });

  it('returns a bare metadata reference unchanged', () => {
    expect(
      extractContentAddressedPosterRef('metadata://posters/tv.plex.agents_9f8')
    ).toBe('metadata://posters/tv.plex.agents_9f8');
  });

  it('extracts an upload reference from an absolute /file?url= URL', () => {
    const url = `http://10.0.0.5:32400/library/metadata/815/file?url=${encodeURIComponent(
      'upload://posters/abc123'
    )}&${TOKEN}`;

    expect(extractContentAddressedPosterRef(url)).toBe(
      'upload://posters/abc123'
    );
  });

  it('extracts an upload reference from a relative /file?url= path', () => {
    const url = `/library/metadata/815/file?url=${encodeURIComponent(
      'upload://posters/abc123'
    )}`;

    expect(extractContentAddressedPosterRef(url)).toBe(
      'upload://posters/abc123'
    );
  });

  // Plex namespaces season uploads under a nested path.
  it('preserves the nested path of a season upload reference', () => {
    const ref = 'upload://posters/seasons/6/82486a9189b7d91fd297c043835fb476';
    const url = `http://10.0.0.5:32400/library/metadata/62164/file?url=${encodeURIComponent(
      ref
    )}&${TOKEN}`;

    expect(extractContentAddressedPosterRef(url)).toBe(ref);
  });

  it('extracts a metadata reference from a /file?url= URL', () => {
    const ref = 'metadata://posters/d37b9ef119f60e85bf8868bf35e1988d600a29a0';
    const url = `/library/metadata/63248/file?url=${encodeURIComponent(ref)}`;

    expect(extractContentAddressedPosterRef(url)).toBe(ref);
  });

  // A /thumb/{version} URL always serves whatever poster is selected right now,
  // so it can never recover a superseded original.
  it('rejects a decorative /thumb/{version} URL', () => {
    expect(
      extractContentAddressedPosterRef('/library/metadata/815/thumb/1765149596')
    ).toBeNull();
    expect(
      extractContentAddressedPosterRef(
        `http://10.0.0.5:32400/library/metadata/815/thumb/1765149596?${TOKEN}`
      )
    ).toBeNull();
  });

  // images.plex.tv transcodes a provider poster down to 225x336.
  it('rejects a plex.tv photo transcode of a provider poster', () => {
    const url =
      'https://images.plex.tv/photo?height=336&width=225&minSize=1&upscale=1&url=' +
      encodeURIComponent('https://image.tmdb.org/t/p/original/kX5.jpg');

    expect(extractContentAddressedPosterRef(url)).toBeNull();
  });

  it('rejects a direct provider CDN URL', () => {
    expect(
      extractContentAddressedPosterRef(
        'https://image.tmdb.org/t/p/original/kX5.jpg'
      )
    ).toBeNull();
  });

  it('rejects a local poster reference', () => {
    expect(
      extractContentAddressedPosterRef(
        'local:///posters/Movie (2020)/poster.jpg'
      )
    ).toBeNull();
  });

  it('returns null for empty and malformed input', () => {
    expect(extractContentAddressedPosterRef(undefined)).toBeNull();
    expect(extractContentAddressedPosterRef(null)).toBeNull();
    expect(extractContentAddressedPosterRef('')).toBeNull();
    expect(extractContentAddressedPosterRef('not a url at all')).toBeNull();
  });
});

describe('extractThumbId', () => {
  it('normalizes the two shapes of the same nested season upload to one id', () => {
    const ref = 'upload://posters/seasons/6/82486a9189b7d91fd297c043835fb476';
    // Tracked poster URLs are always absolute: getCurrentPosterUrl prefixes the
    // configured base URL before the value is persisted.
    const fileUrl = `http://10.0.0.5:32400/library/metadata/62164/file?url=${encodeURIComponent(
      ref
    )}&${TOKEN}`;

    expect(extractThumbId(ref)).toBe(extractThumbId(fileUrl));
    expect(posterUrlsMatch(ref, fileUrl)).toBe(true);
  });

  // Pins a known gap: the format-4 branch parses with `new URL(url)`, which
  // throws on a relative path, so the id is not extracted. Harmless today
  // because persisted poster URLs are absolute, but a relative value would
  // silently compare as "no match" rather than raise.
  it('does not extract an id from a relative /file?url= path', () => {
    const ref = 'upload://posters/abc123';
    const relative = `/library/metadata/815/file?url=${encodeURIComponent(
      ref
    )}`;

    expect(extractThumbId(relative)).toBeNull();
    expect(posterUrlsMatch(ref, relative)).toBe(false);
    // The recovery parser handles the relative form regardless.
    expect(extractContentAddressedPosterRef(relative)).toBe(ref);
  });

  it('does not match a decorative thumb URL against the overlay it serves', () => {
    // The overlay is stored content-addressed; the original was recorded as a
    // /thumb/ URL. Different ids, so posterUrlsMatch cannot flag the collision.
    expect(
      posterUrlsMatch(
        '/library/metadata/815/thumb/1765149596',
        `/library/metadata/815/file?url=${encodeURIComponent(
          'upload://posters/overlay-sha'
        )}`
      )
    ).toBe(false);
  });
});

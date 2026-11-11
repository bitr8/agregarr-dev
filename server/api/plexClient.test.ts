import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import PlexClient from './plexClient';
import { fetchPlexMetadataBatches } from './plexMetadataBatch';

interface Seen {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  remotePort?: number;
}

let seen: Seen[] = [];
let port = 0;
let flakyHits = 0;
const server = createServer((req, res) => {
  seen.push({
    method: req.method,
    url: req.url,
    headers: req.headers,
    remotePort: req.socket.remotePort,
  });
  const path = (req.url ?? '').split('?')[0];
  switch (path) {
    case '/json':
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          MediaContainer: { size: 1, Metadata: [{ ratingKey: '1' }] },
        })
      );
      return;
    case '/json-charset':
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"MediaContainer":{}}');
      return;
    case '/xml':
      res.writeHead(200, { 'content-type': 'text/xml;charset=utf-8' });
      res.end(
        '<MediaContainer size="1"><Video ratingKey="7" title="T"/></MediaContainer>'
      );
      return;
    case '/plain':
      res.writeHead(200);
      res.end('hello');
      return;
    case '/empty-put':
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('');
      return;
    case '/gzip': {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const zlib = require('zlib');
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      });
      res.end(zlib.gzipSync('{"a":1}'));
      return;
    }
    case '/slow':
      setTimeout(() => res.end('late'), 500);
      return;
    case '/truncated':
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '500',
      });
      res.write('{"MediaContainer":');
      setTimeout(() => req.socket.destroy(), 20);
      return;
    case '/flaky-batch':
      flakyHits += 1;
      if (flakyHits === 1) {
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': '500',
        });
        res.write('{"MediaContainer":');
        setTimeout(() => req.socket.destroy(), 20);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ MediaContainer: { Metadata: [{ ratingKey: '9' }] } })
      );
      return;
    case '/stalled':
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '500',
      });
      res.write('{"MediaContainer":');
      return;
    case '/redirect':
      res.writeHead(302, { location: '/json' });
      res.end();
      return;
    case '/forbidden':
      res.writeHead(403);
      res.end();
      return;
    case '/unauthorized':
      res.writeHead(401);
      res.end();
      return;
    case '/missing':
      res.writeHead(404);
      res.end('nope');
      return;
    case '/boom':
      res.writeHead(500);
      res.end();
      return;
    default:
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
  }
});

const make = (
  extra: Partial<ConstructorParameters<typeof PlexClient>[0]> = {}
) =>
  new PlexClient({
    hostname: '127.0.0.1',
    port,
    https: false,
    token: 'tok-123',
    options: {
      identifier: 'client-xyz',
      product: 'Agregarr',
      deviceName: 'Agregarr',
      platform: 'Agregarr',
    },
    ...extra,
  });

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.close();
});

describe('PlexClient', () => {
  it('parses application/json responses', async () => {
    const res = await make().query<{ MediaContainer: { size: number } }>(
      '/json'
    );
    expect(res.MediaContainer.size).toBe(1);
  });

  it('only treats the exact application/json content-type as JSON', async () => {
    const res = await make().query('/json-charset');
    expect(Buffer.isBuffer(res)).toBe(true);
  });

  it('parses xml with attributes under .attributes', async () => {
    const res = (await make().query('/xml')) as {
      MediaContainer: {
        attributes: { size: string };
        Video: { attributes: { ratingKey: string } }[];
      };
    };
    expect(res.MediaContainer.attributes.size).toBe('1');
    expect(res.MediaContainer.Video[0].attributes.ratingKey).toBe('7');
  });

  it('returns a string when there is no content-type', async () => {
    expect(await make().query('/plain')).toBe('hello');
  });

  it('returns a Buffer for other content types', async () => {
    const res = await make().query('/empty-put');
    expect(Buffer.isBuffer(res)).toBe(true);
  });

  it('decompresses gzip bodies', async () => {
    expect(await make().query('/gzip')).toEqual({ a: 1 });
  });

  it('sends token, identity and extra headers; drops non-string extras', async () => {
    seen = [];
    await make().query({
      uri: '/json?x=1',
      extraHeaders: {
        'X-Plex-Container-Size': '50',
        'X-Plex-Container-Start': 0,
      },
    });
    const h = seen[0].headers;
    expect(seen[0].url).toBe('/json?x=1');
    expect(h['accept']).toBe('application/json');
    expect(h['x-plex-token']).toBe('tok-123');
    expect(h['x-plex-client-identifier']).toBe('client-xyz');
    expect(h['x-plex-product']).toBe('Agregarr');
    expect(h['x-plex-device-name']).toBe('Agregarr');
    expect(h['x-plex-platform']).toBe('Agregarr');
    expect(h['x-plex-provides']).toBe('controller');
    expect(h['x-plex-container-size']).toBe('50');
    expect(h['x-plex-container-start']).toBeUndefined();
  });

  it('uses the right verb for post/put/delete and parses post/put bodies', async () => {
    seen = [];
    const c = make();
    expect(await c.postQuery('/json')).toMatchObject({
      MediaContainer: { size: 1 },
    });
    expect(await c.putQuery('/json')).toMatchObject({
      MediaContainer: { size: 1 },
    });
    expect(await c.deleteQuery('/json')).toBeUndefined();
    expect(seen.map((s) => s.method)).toEqual(['POST', 'PUT', 'DELETE']);
  });

  it('rejects non-2xx with the response code in the message', async () => {
    const err = await make()
      .query('/missing')
      .catch((e) => e);
    expect(err.message).toBe(
      'Plex Server didnt respond with a valid 2xx status code, response code: 404'
    );
    const err500 = (await make()
      .putQuery('/boom')
      .catch((e: Error) => e)) as Error;
    expect(err500.message).toMatch(/response code:\s*500$/);
    const errDel = await make()
      .deleteQuery('/missing')
      .catch((e) => e);
    expect(errDel.message).toMatch(/response code:\s*404$/);
  });

  it('rejects 403 with the permissions message and no response code', async () => {
    const err = await make()
      .deleteQuery('/forbidden')
      .catch((e) => e);
    expect(err.message).toMatch(
      /^Plex Server denied request due to lack of managed user permissions/
    );
    expect(err.message).not.toMatch(/response code/);
  });

  it('rejects 401 without a response code', async () => {
    const err = await make()
      .query('/unauthorized')
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toMatch(/response code/);
  });

  it('rejects with ESOCKETTIMEDOUT on timeout', async () => {
    const err = await make({ timeout: 50 })
      .query('/slow')
      .catch((e) => e);
    expect(err.message).toBe('ESOCKETTIMEDOUT');
  });

  it('rejects with a connection error when nothing listens', async () => {
    const err = await make({ port: 1 })
      .query('/json')
      .catch((e) => e);
    expect(String(err.code ?? err.message)).toMatch(/ECONNREFUSED/);
  });

  it('picks the URL scheme from port and the https option', () => {
    const base = (o: Partial<ConstructorParameters<typeof PlexClient>[0]>) =>
      (make(o) as unknown as { baseUrl: string }).baseUrl;
    expect(base({ port: 443, https: undefined })).toBe('https://127.0.0.1:443');
    expect(base({ port: 32400, https: undefined })).toBe(
      'http://127.0.0.1:32400'
    );
    expect(base({ port: 443, https: false })).toBe('http://127.0.0.1:443');
    expect(base({ port: 32400, https: true })).toBe('https://127.0.0.1:32400');
  });

  it('reports a peer disconnect mid-body as ECONNRESET', async () => {
    const err = await make()
      .query('/truncated')
      .catch((e) => e);
    expect(err.code).toBe('ECONNRESET');
  });

  it('lets the metadata batcher retry a mid-body disconnect', async () => {
    flakyHits = 0;
    const c = make();
    const result = await fetchPlexMetadataBatches(
      ['9'],
      async () =>
        (
          await c.query<{
            MediaContainer: { Metadata: { ratingKey: string }[] };
          }>('/flaky-batch')
        ).MediaContainer.Metadata,
      { retryDelayMs: 0 }
    );
    expect(flakyHits).toBe(2);
    expect(result.get('9')).toBeDefined();
  });

  it('reuses one socket across sequential calls', async () => {
    seen = [];
    const c = make();
    await c.query('/json');
    await c.query('/json');
    await c.putQuery('/json');
    expect(new Set(seen.map((x) => x.remotePort)).size).toBe(1);
  });

  it('reports a stalled body as ESOCKETTIMEDOUT', async () => {
    const err = await make({ timeout: 150 })
      .query('/stalled')
      .catch((e) => e);
    expect(err.message).toBe('ESOCKETTIMEDOUT');
    expect(err.code).toBe('ESOCKETTIMEDOUT');
  });

  it('reports a connect that never completes as ETIMEDOUT', async () => {
    const err = await make({ hostname: '10.255.255.1', timeout: 150 })
      .query('/json')
      .catch((e) => e);
    if (['ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED'].includes(err.code))
      return;
    expect(err.code).toBe('ETIMEDOUT');
  });

  it('follows redirects on GET but rejects them on PUT/POST/DELETE', async () => {
    const c = make();
    expect(await c.query('/redirect')).toMatchObject({
      MediaContainer: { size: 1 },
    });
    for (const call of [c.putQuery, c.postQuery, c.deleteQuery]) {
      const err = (await call
        .call(c, '/redirect')
        .catch((e: Error) => e)) as Error;
      expect(err.message).toMatch(/response code:\s*302$/);
    }
  });
});

import { fileRouteLimiter } from '@server/middleware/rateLimit';
import express from 'express';
import type { AddressInfo } from 'net';
import { describe, expect, it } from 'vitest';

describe('fileRouteLimiter', () => {
  it('sets standard headers and 429s past the cap', async () => {
    const app = express();
    app.get('/', fileRouteLimiter, (_q, r) => r.send('ok'));
    const srv = app.listen(0);
    const { port } = srv.address() as AddressInfo;
    let last = 200;
    let limit: string | null = null;
    for (let i = 0; i < 601; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      last = res.status;
      limit = limit ?? res.headers.get('ratelimit-limit');
    }
    srv.close();
    expect(limit).toBe('600');
    expect(last).toBe(429);
  });
});

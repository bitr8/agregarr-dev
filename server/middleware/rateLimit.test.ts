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
    const hit = async () => {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      limit = limit ?? res.headers.get('ratelimit-limit');
      return res.status;
    };
    for (let batch = 0; batch < 6; batch++) {
      await Promise.all(Array.from({ length: 100 }, hit));
    }
    last = await hit();
    srv.close();
    expect(limit).toBe('600');
    expect(last).toBe(429);
  });
});

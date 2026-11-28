import axios from 'axios';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', () => ({ getSettings: () => ({}) }));
vi.mock('@server/lib/collections/core/CollectionUtilities', () => ({
  getAdminUser: async () => ({ plexToken: 't' }),
}));
vi.mock('@server/api/plexapi', () => ({
  default: class {
    plexClient = { query: mocks.query };
    getLibraries = async () => [];
  },
}));

import searchRouter from './search';

describe('plex search reason filter', () => {
  let server: Server;
  let baseURL: string;

  beforeAll(async () => {
    const app = express();
    app.use('/plex', searchRouter);
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  it('keeps section hits and untagged hits, drops related matches', async () => {
    mocks.query.mockResolvedValue({
      MediaContainer: {
        Hub: [
          {
            Metadata: [
              {
                ratingKey: '1',
                title: 'Akira',
                type: 'movie',
                reason: 'section',
                reasonTitle: 'Movies',
                librarySectionTitle: 'Movies',
                librarySectionID: 1,
              },
              {
                ratingKey: '2',
                title: 'Akira (Untagged)',
                type: 'movie',
                librarySectionTitle: 'Movies',
                librarySectionID: 1,
              },
              {
                ratingKey: '3',
                title: 'Related Film',
                type: 'movie',
                reason: 'actor',
                reasonTitle: 'Some Actor',
                librarySectionTitle: 'Movies',
                librarySectionID: 1,
              },
            ],
          },
        ],
      },
    });

    const res = await axios.get(`${baseURL}/plex/search`, {
      params: { query: 'Akira' },
    });

    expect(
      res.data.results.map((r: { ratingKey: string }) => r.ratingKey)
    ).toEqual(['1', '2']);
  });
});

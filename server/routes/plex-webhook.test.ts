import axios from 'axios';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
  unscrobble: vi.fn(),
  progress: vi.fn(),
  tokens: [] as (string | undefined)[],
  sharedToken: vi.fn(),
}));

vi.mock('@server/api/plexapi', () => ({
  default: class {
    constructor({ plexToken }: { plexToken?: string }) {
      mocks.tokens.push(plexToken);
      (this as { token?: string }).token = plexToken;
    }
    markItemAsUnplayed(key: string) {
      return mocks.unscrobble((this as { token?: string }).token, key);
    }
    resetItemProgress(key: string) {
      return mocks.progress((this as { token?: string }).token, key);
    }
  },
}));
vi.mock('@server/api/plextv', () => ({
  default: class {
    getSharedUserToken(machineId: string, id: number) {
      return mocks.sharedToken(machineId, id);
    }
  },
}));
vi.mock('@server/lib/collections/core/CollectionUtilities', () => ({
  getAdminUser: async () => ({ plexToken: 'admin-token', plexId: 100 }),
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    main: { plexWebhookToken: 'secret' },
    plex: { machineId: 'machine-1' },
  }),
}));

import router from './plex-webhook';

describe('Plex webhook placeholder unwatch', () => {
  let server: Server;
  let baseURL: string;

  beforeAll(async () => {
    const app = express();
    app.use('/plex-webhook', router);
    server = await new Promise<Server>((resolve) => {
      const l = app.listen(0, '127.0.0.1', () => resolve(l));
    });
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tokens.length = 0;
  });

  const send = async (payload: unknown) => {
    const form = new FormData();
    form.append('payload', JSON.stringify(payload));
    await axios.post(`${baseURL}/plex-webhook?token=secret`, form);
    await vi.waitFor(() => expect(mocks.unscrobble).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
  };

  const trailer = {
    ratingKey: '555',
    type: 'movie',
    title: 'Some Film',
    editionTitle: 'Trailer',
  };

  it('unscrobbles and resets progress as the shared user who played it', async () => {
    mocks.sharedToken.mockResolvedValue('user-token');
    await send({
      event: 'media.scrobble',
      Account: { id: 200 },
      Metadata: trailer,
    });

    expect(mocks.sharedToken).toHaveBeenCalledWith('machine-1', 200);
    expect(mocks.unscrobble).toHaveBeenCalledWith('admin-token', '555');
    expect(mocks.unscrobble).toHaveBeenCalledWith('user-token', '555');
    expect(mocks.progress).toHaveBeenCalledWith('user-token', '555');
  });

  it('does not look up a shared token when the admin played it', async () => {
    await send({
      event: 'media.play',
      Account: { id: 100 },
      Metadata: trailer,
    });

    expect(mocks.sharedToken).not.toHaveBeenCalled();
    expect(mocks.unscrobble).toHaveBeenCalledTimes(1);
  });

  it('leaves real titles alone', async () => {
    mocks.sharedToken.mockResolvedValue('user-token');
    const form = new FormData();
    form.append(
      'payload',
      JSON.stringify({
        event: 'media.scrobble',
        Account: { id: 200 },
        Metadata: { ratingKey: '9', type: 'movie', title: 'Real Film' },
      })
    );
    await axios.post(`${baseURL}/plex-webhook?token=secret`, form);
    await new Promise((r) => setTimeout(r, 100));
    expect(mocks.unscrobble).not.toHaveBeenCalled();
    expect(mocks.sharedToken).not.toHaveBeenCalled();
  });

  it('skips the user pass when no shared token exists', async () => {
    mocks.sharedToken.mockResolvedValue(null);
    await send({
      event: 'media.stop',
      Account: { id: 300 },
      Metadata: trailer,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(mocks.unscrobble).toHaveBeenCalledTimes(1);
  });
});

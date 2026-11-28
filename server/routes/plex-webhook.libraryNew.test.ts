import axios from 'axios';
import express from 'express';
import { readFileSync } from 'fs';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { join } from 'path';
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
  enqueue: vi.fn(),
  findOne: vi.fn(),
  swapEnabled: { value: true },
}));

vi.mock('@server/lib/placeholderSwapTrigger', () => ({
  default: { enqueue: mocks.enqueue },
}));
vi.mock('@server/api/plexapi', () => ({ default: class {} }));
vi.mock('@server/api/plextv', () => ({ default: class {} }));
vi.mock('@server/datasource', () => ({
  getRepository: () => ({ findOne: mocks.findOne }),
}));
vi.mock('@server/entity/PlaceholderItem', () => ({ PlaceholderItem: {} }));
vi.mock('@server/lib/collections/core/CollectionUtilities', () => ({
  getAdminUser: async () => ({ plexToken: 't', plexId: 1 }),
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({
    main: {
      plexWebhookToken: 'secret',
      placeholderSwapOnPlexWebhook: mocks.swapEnabled.value,
    },
    plex: { machineId: 'm' },
  }),
}));

import router from './plex-webhook';

interface Fixture {
  event: string;
  Metadata: Record<string, unknown> & { Guid: { id: string }[] };
}

const [showEvent, placeholderEvent, episodeEvent] = readFileSync(
  join(__dirname, '__fixtures__', 'plex-library-new.jsonl'),
  'utf8'
)
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as Fixture);

describe('Plex webhook library.new placeholder swap', () => {
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
    mocks.swapEnabled.value = true;
    mocks.findOne.mockResolvedValue({ id: 1 });
    mocks.enqueue.mockReturnValue({ queued: true, deduplicated: false });
  });

  const send = async (payload: unknown) => {
    const form = new FormData();
    form.append('payload', JSON.stringify(payload));
    await axios.post(`${baseURL}/plex-webhook?token=secret`, form);
    // the handler keeps running after the 200
    await new Promise((r) => setTimeout(r, 50));
  };

  it('does nothing, and queries nothing, when the setting is off', async () => {
    mocks.swapEnabled.value = false;
    await send(showEvent);
    expect(mocks.findOne).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues the show when a held placeholder matches its tmdb id', async () => {
    await send(showEvent);
    expect(mocks.findOne).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ ratingKey: '5001' })
    );
  });

  it('prefilters on every tmdb guid and the media type', async () => {
    const event = structuredClone(showEvent);
    event.Metadata.Guid.push({ id: 'tmdb://999' });
    await send(event);
    const { where } = mocks.findOne.mock.calls[0][0];
    const tmdbClause = where.find((w: { tmdbId?: unknown }) => w.tmdbId);
    expect(tmdbClause.mediaType).toBe('tv');
    expect(tmdbClause.tmdbId.value).toEqual([324502, 999]);
    const tvdbClause = where.find((w: { tvdbId?: unknown }) => w.tvdbId);
    expect(tvdbClause.tvdbId.value).toEqual([478752]);
  });

  it('skips placeholder metadata without touching the DB', async () => {
    await send(placeholderEvent);
    expect(mocks.findOne).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('maps an episode to its show and matches by show ratingKey', async () => {
    await send(episodeEvent);
    const { where } = mocks.findOne.mock.calls[0][0];
    expect(where).toEqual([
      { mediaType: 'tv', plexRatingKey: '5005' },
      { mediaType: 'tv', pendingRealRatingKey: '5005' },
    ]);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ ratingKey: '5005' })
    );
  });

  it('maps a season to its parent', async () => {
    const season = structuredClone(episodeEvent);
    season.Metadata.type = 'season';
    delete season.Metadata.grandparentRatingKey;
    season.Metadata.parentRatingKey = '777';
    await send(season);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ ratingKey: '777' })
    );
  });

  it('does not enqueue when no placeholder row matches', async () => {
    mocks.findOne.mockResolvedValue(null);
    await send(showEvent);
    expect(mocks.findOne).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('skips a non-numeric ratingKey', async () => {
    const bad = structuredClone(showEvent);
    bad.Metadata.ratingKey = '1&x=2';
    await send(bad);
    expect(mocks.findOne).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('skips an episode with no usable grandparent key', async () => {
    const bad = structuredClone(episodeEvent);
    bad.Metadata.grandparentRatingKey = 'abc';
    await send(bad);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('turns a burst of unrelated announcements into one lookup each and no swaps', async () => {
    mocks.findOne.mockResolvedValue(null);
    for (let i = 0; i < 90; i++) {
      await send({
        ...showEvent,
        Metadata: {
          ...showEvent.Metadata,
          ratingKey: String(100000 + i),
          Guid: [
            { id: `tmdb://${900000 + i}` },
            { id: `tvdb://${800000 + i}` },
          ],
        },
      });
    }
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.findOne.mock.calls.length).toBeLessThanOrEqual(90 * 2);
    expect(mocks.findOne.mock.calls.length).toBeGreaterThanOrEqual(90);
  });

  it('ignores an announcement whose Guid is not a list', async () => {
    await send({
      ...showEvent,
      Metadata: { ...showEvent.Metadata, Guid: { id: 'tmdb://1' } },
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

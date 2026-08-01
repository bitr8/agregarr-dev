import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdGenerator } from './idGenerator';

vi.mock('@server/lib/settings', () => {
  let nextConfigId: number | undefined;
  const mockSettings = {
    plex: {
      collectionConfigs: [],
      hubConfigs: [],
      preExistingCollectionConfigs: [],
    },
    main: {
      get nextConfigId() {
        return nextConfigId;
      },
      set nextConfigId(v: number | undefined) {
        nextConfigId = v;
      },
    },
    save: vi.fn(),
  };
  return {
    getSettings: () => mockSettings,
    _mockSettings: mockSettings,
    _resetNextConfigId: () => {
      nextConfigId = undefined;
    },
  };
});

async function getMocks() {
  const mod = await import('@server/lib/settings');
  return mod as typeof mod & {
    _mockSettings: ReturnType<typeof mod.getSettings>;
    _resetNextConfigId: () => void;
  };
}

describe('IdGenerator', () => {
  afterEach(async () => {
    const { _mockSettings, _resetNextConfigId } = await getMocks();
    _mockSettings.plex.collectionConfigs = [];
    _resetNextConfigId();
    vi.mocked(_mockSettings.save).mockClear();
  });

  it('generateId returns a sequential string ID', async () => {
    const id = IdGenerator.generateId();
    expect(typeof id).toBe('string');
    expect(parseInt(id, 10)).toBeGreaterThanOrEqual(10000);
  });

  it('generateId calls save once', async () => {
    const { _mockSettings } = await getMocks();
    IdGenerator.generateId();
    expect(_mockSettings.save).toHaveBeenCalledTimes(1);
  });

  it('generateIds returns N unique sequential IDs', () => {
    const ids = IdGenerator.generateIds(5);
    expect(ids).toHaveLength(5);
    const nums = ids.map((id) => parseInt(id, 10));
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]).toBe(nums[i - 1] + 1);
    }
  });

  it('generateIds calls save exactly once', async () => {
    const { _mockSettings } = await getMocks();
    IdGenerator.generateIds(10);
    expect(_mockSettings.save).toHaveBeenCalledTimes(1);
  });

  it('generateIds(0) returns empty array without saving', async () => {
    const { _mockSettings } = await getMocks();
    const ids = IdGenerator.generateIds(0);
    expect(ids).toEqual([]);
    expect(_mockSettings.save).not.toHaveBeenCalled();
  });

  it('generateIds does not collide with existing configs', async () => {
    const { _mockSettings } = await getMocks();
    _mockSettings.plex.collectionConfigs = [
      { id: '10005' },
      { id: '10003' },
    ] as never[];
    const ids = IdGenerator.generateIds(3);
    const nums = ids.map((id) => parseInt(id, 10));
    expect(nums[0]).toBe(10006);
    expect(nums[1]).toBe(10007);
    expect(nums[2]).toBe(10008);
  });
});

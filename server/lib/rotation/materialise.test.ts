import type {
  CollectionConfig,
  PreExistingCollectionConfig,
} from '@server/lib/settings';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/entity/User', () => ({ User: class {} }));
vi.mock('@server/lib/collections/utils/TemplateEngine', () => ({
  templateEngine: {},
}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({ plex: { collectionConfigs: [] }, save: vi.fn() }),
}));

import { emptyState } from './engine';
import {
  applyManagedFields,
  captureOwn,
  classifyCandidate,
  managedFields,
  restoreFields,
  type MemberConfig,
} from './materialise';
import type { RotationGroup, RotationMember, Visibility } from './types';

const NOW = new Date('2026-03-10T08:00:00.000Z');
const SURFACES: Visibility = {
  usersHome: true,
  serverOwnerHome: true,
  libraryRecommended: false,
};
const NONE: Visibility = {
  usersHome: false,
  serverOwnerHome: false,
  libraryRecommended: false,
};

const col = (o: Record<string, unknown> = {}): CollectionConfig =>
  ({
    id: 'cfg-a',
    name: 'Collection A',
    type: 'tmdb',
    subtype: 'popular',
    libraryId: 'lib-1',
    libraryName: 'Library One',
    visibilityConfig: {
      usersHome: false,
      serverOwnerHome: true,
      libraryRecommended: true,
    },
    sortOrderHome: 4,
    randomizeHomeOrder: true,
    ...o,
  } as unknown as CollectionConfig);

const pre = (o: Record<string, unknown> = {}): PreExistingCollectionConfig =>
  ({
    id: 'cfg-p',
    name: 'Existing P',
    libraryId: 'lib-1',
    libraryName: 'Library One',
    visibilityConfig: NONE,
    sortOrderHome: 0,
    ...o,
  } as unknown as PreExistingCollectionConfig);

const restriction = (inactive?: Visibility) => ({
  alwaysActive: false,
  weeklySchedule: { monday: true },
  ...(inactive ? { inactiveVisibilityConfig: inactive } : {}),
});

const member = (key = 'collection:cfg-a'): RotationMember => ({
  key,
  kind: key.startsWith('pre') ? 'preExisting' : 'collection',
  configId: key.split(':')[1],
  name: 'x',
  addedAt: '2026-01-01T00:00:00.000Z',
});

const group = (o: Partial<RotationGroup> = {}): RotationGroup => ({
  id: 'grp-a',
  name: 'Group A',
  libraryId: 'lib-1',
  enabled: true,
  slotCount: 2,
  interval: 'daily',
  order: 'sequential',
  surfaces: SURFACES,
  members: [member()],
  state: emptyState(),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...o,
});

const slot = (occupant: string | null, pos = 3) => ({
  id: 's1',
  occupant,
  sortOrderHome: pos,
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('captureOwn', () => {
  it('copies the four values and stamps the time', () => {
    const c = col({ timeRestriction: restriction({ ...SURFACES }) });
    const own = captureOwn(c, NOW);
    expect(own).toEqual({
      visibilityConfig: c.visibilityConfig,
      inactiveVisibilityConfig: SURFACES,
      sortOrderHome: 4,
      randomizeHomeOrder: true,
      capturedAt: '2026-03-10T08:00:00.000Z',
    });
    expect(own.visibilityConfig).not.toBe(c.visibilityConfig);
  });

  it('records absent fields as null', () => {
    const c = col();
    delete (c as unknown as Record<string, unknown>).sortOrderHome;
    delete (c as unknown as Record<string, unknown>).randomizeHomeOrder;
    const own = captureOwn(c, NOW);
    expect(own.sortOrderHome).toBeNull();
    expect(own.randomizeHomeOrder).toBeNull();
    expect(own.inactiveVisibilityConfig).toBeNull();
  });
});

describe('capture then restore is the identity', () => {
  const cases: [string, () => MemberConfig][] = [
    ['plain collection', () => col()],
    [
      'with a time restriction and inactive visibility',
      () => col({ timeRestriction: restriction({ ...SURFACES }) }),
    ],
    [
      'with a time restriction and no inactive visibility',
      () => col({ timeRestriction: restriction() }),
    ],
    [
      'with absent sort order and randomise',
      () => {
        const c = col();
        delete (c as unknown as Record<string, unknown>).sortOrderHome;
        delete (c as unknown as Record<string, unknown>).randomizeHomeOrder;
        return c;
      },
    ],
    ['pre-existing', () => pre()],
  ];

  it.each(cases)('%s, after a managed apply in between', (_name, make) => {
    const config = make();
    const original = clone(config);
    const own = captureOwn(config, NOW);
    const m = member(
      config.id === 'cfg-p' ? 'preExisting:cfg-p' : 'collection:cfg-a'
    );
    const g = group({ members: [m] });
    applyManagedFields(config, managedFields(g, m, config, slot(null)));
    restoreFields(config, own);
    expect(clone(config)).toEqual(original);
    expect(
      Object.keys(config).sort(),
      'no stray or missing keys after restore'
    ).toEqual(Object.keys(original).sort());
  });
});

describe('managedFields', () => {
  it('a showing member gets the group surfaces and the slot position', () => {
    const c = col();
    const m = member();
    const f = managedFields(group(), m, c, slot(m.key, 7));
    expect(f).toEqual({
      visibilityConfig: SURFACES,
      inactiveVisibilityConfig: undefined,
      sortOrderHome: 7,
      randomizeHomeOrder: false,
    });
    expect(f.visibilityConfig).not.toBe(group().surfaces);
  });

  it('a waiting member gets all false and position 0', () => {
    const c = col();
    const f = managedFields(group(), member(), c, undefined);
    expect(f.visibilityConfig).toEqual(NONE);
    expect(f.sortOrderHome).toBe(0);
    expect(f.randomizeHomeOrder).toBe(false);
  });

  it('a slot occupied by someone else does not make this member showing', () => {
    const f = managedFields(
      group(),
      member(),
      col(),
      slot('collection:zzz', 5)
    );
    expect(f.visibilityConfig).toEqual(NONE);
    expect(f.sortOrderHome).toBe(0);
  });

  it('forces inactiveVisibilityConfig all false only when the config has a time restriction', () => {
    const m = member();
    const restricted = col({ timeRestriction: restriction({ ...SURFACES }) });
    const plain = col();
    expect(
      managedFields(group(), m, restricted, slot(m.key))
        .inactiveVisibilityConfig
    ).toEqual(NONE);
    expect(
      managedFields(group(), m, plain, slot(m.key)).inactiveVisibilityConfig
    ).toBeUndefined();
  });
});

describe('applyManagedFields', () => {
  const m = member();

  it('writes visibility, position and randomise, and reports a change', () => {
    const c = col();
    const changed = applyManagedFields(
      c,
      managedFields(group(), m, c, slot(m.key, 9))
    );
    expect(changed).toBe(true);
    expect(c.visibilityConfig).toEqual(SURFACES);
    expect(c.sortOrderHome).toBe(9);
    expect(c.randomizeHomeOrder).toBe(false);
  });

  it('is idempotent: the second apply changes nothing', () => {
    const c = col({ timeRestriction: restriction({ ...SURFACES }) });
    const f = managedFields(group(), m, c, slot(m.key, 9));
    expect(applyManagedFields(c, f)).toBe(true);
    const after = clone(c);
    expect(applyManagedFields(c, f)).toBe(false);
    expect(clone(c)).toEqual(after);
  });

  it('does not add a randomise field to a config that never had one', () => {
    const c = col();
    delete (c as unknown as Record<string, unknown>).randomizeHomeOrder;
    applyManagedFields(c, managedFields(group(), m, c, slot(m.key, 9)));
    expect('randomizeHomeOrder' in c).toBe(false);
  });

  it('sets the inactive visibility to all false on a restricted config', () => {
    const c = col({ timeRestriction: restriction({ ...SURFACES }) });
    applyManagedFields(c, managedFields(group(), m, c, slot(null)));
    expect(c.timeRestriction?.inactiveVisibilityConfig).toEqual(NONE);
  });

  it('leaves a config without a time restriction free of one', () => {
    const c = col();
    applyManagedFields(c, managedFields(group(), m, c, slot(m.key)));
    expect('timeRestriction' in c).toBe(false);
  });

  it('adoptPosition leaves an occupant dragged position alone', () => {
    const c = col({ sortOrderHome: 12 });
    const f = managedFields(group(), m, c, slot(m.key, 3));
    const changed = applyManagedFields(c, f, { adoptPosition: true });
    expect(c.sortOrderHome).toBe(12);
    expect(changed).toBe(true);
    expect(c.visibilityConfig).toEqual(SURFACES);
  });

  it('adoptPosition still assigns the slot position when the occupant has none', () => {
    const c = col({ sortOrderHome: 0 });
    applyManagedFields(c, managedFields(group(), m, c, slot(m.key, 3)), {
      adoptPosition: true,
    });
    expect(c.sortOrderHome).toBe(3);
  });

  it('adoptPosition never keeps a position on a waiting member', () => {
    const c = col({ sortOrderHome: 12 });
    applyManagedFields(c, managedFields(group(), m, c, undefined), {
      adoptPosition: true,
    });
    expect(c.sortOrderHome).toBe(0);
  });

  it('without adoptPosition the slot position wins', () => {
    const c = col({ sortOrderHome: 12 });
    applyManagedFields(c, managedFields(group(), m, c, slot(m.key, 3)));
    expect(c.sortOrderHome).toBe(3);
  });
});

describe('restoreFields', () => {
  it('writes the four stashed values back', () => {
    const c = col({ timeRestriction: restriction({ ...NONE }) });
    restoreFields(c, {
      visibilityConfig: SURFACES,
      inactiveVisibilityConfig: { ...SURFACES },
      sortOrderHome: 2,
      randomizeHomeOrder: true,
      capturedAt: NOW.toISOString(),
    });
    expect(c.visibilityConfig).toEqual(SURFACES);
    expect(c.timeRestriction?.inactiveVisibilityConfig).toEqual(SURFACES);
    expect(c.sortOrderHome).toBe(2);
    expect(c.randomizeHomeOrder).toBe(true);
  });

  it('deletes fields whose stash value is null', () => {
    const c = col({ timeRestriction: restriction({ ...SURFACES }) });
    restoreFields(c, {
      visibilityConfig: SURFACES,
      inactiveVisibilityConfig: null,
      sortOrderHome: null,
      randomizeHomeOrder: null,
      capturedAt: NOW.toISOString(),
    });
    expect('sortOrderHome' in c).toBe(false);
    expect('randomizeHomeOrder' in c).toBe(false);
    expect(
      c.timeRestriction && 'inactiveVisibilityConfig' in c.timeRestriction
    ).toBe(false);
  });
});

describe('classifyCandidate', () => {
  const classify = (
    c: MemberConfig,
    kind: 'collection' | 'preExisting' = 'collection',
    groups: RotationGroup[] = [],
    groupId?: string
  ) => classifyCandidate(c, kind, 'lib-1', groups, groupId);

  it('accepts an ordinary collection and an ordinary pre-existing one', () => {
    expect(classify(col())).toBeUndefined();
    expect(classify(pre(), 'preExisting')).toBeUndefined();
    expect(classify(col({ type: 'multi-source' }))).toBeUndefined();
    expect(classify(col({ type: 'comingsoon' }))).toBeUndefined();
  });

  it.each([
    [{ type: 'overseerr', subtype: 'users' }],
    [{ type: 'tmdb', subtype: 'auto_franchise' }],
    [{ type: 'plex', subtype: 'genre' }],
    [{ type: 'plex', subtype: 'decade' }],
    [{ type: 'plex', subtype: 'resolution' }],
    [{ type: 'plex', subtype: 'contentRating' }],
    [{ type: 'plex', subtype: 'directors' }],
    [{ type: 'plex', subtype: 'actors' }],
    [
      {
        type: 'tmdb',
        subtype: 'popular',
        collectionRatingKeys: ['rk-1', 'rk-2'],
      },
    ],
  ])('multi-collection config %j cannot join', (o) => {
    expect(classify(col(o))).toEqual({ reason: 'multi_collection' });
  });

  it('a per-user collection cannot join and names the user', () => {
    expect(
      classify(col({ targetUserId: 'u-1', targetUserLabel: 'Alex' }))
    ).toEqual({
      reason: 'per_user',
      reasonDetail: 'Alex',
    });
    expect(classify(col({ targetUserId: 'u-1' }))?.reasonDetail).toBe('u-1');
  });

  it.each([
    [{ type: 'filtered_hub' }],
    [{ type: 'plex', subtype: 'separator' }],
  ])('row markers %j cannot join', (o) => {
    expect(classify(col(o))).toEqual({ reason: 'row_marker' });
  });

  it('a pre-existing collection with the exclude label cannot join', () => {
    expect(classify(pre({ excludeFromOrdering: true }), 'preExisting')).toEqual(
      { reason: 'exclude_label' }
    );
  });

  it('another library cannot join and names its library', () => {
    expect(
      classify(col({ libraryId: 'lib-2', libraryName: 'Library Two' }))
    ).toEqual({
      reason: 'other_library',
      reasonDetail: 'Library Two',
    });
  });

  it('a member of another group cannot join; its own group is fine', () => {
    const other = group({
      id: 'grp-b',
      name: 'Group B',
      members: [member('collection:cfg-a')],
    });
    expect(classify(col(), 'collection', [other])).toEqual({
      reason: 'other_group',
      reasonDetail: 'Group B',
    });
    expect(classify(col(), 'collection', [other], 'grp-b')).toBeUndefined();
    expect(classify(pre(), 'preExisting', [other])).toBeUndefined();
  });

  it('the exclude label is not applied to Agregarr collections', () => {
    expect(classify(col({ excludeFromOrdering: true }))).toBeUndefined();
  });
});

import {
  draftMembers,
  draftProblem,
  homeRowAction,
  membersToKeep,
} from '@app/components/Rotation/utils';
import type {
  Candidate,
  GroupInput,
} from '@server/interfaces/api/rotationInterfaces';
import { describe, expect, it } from 'vitest';

const draft = (over: Partial<GroupInput> = {}): GroupInput => ({
  name: 'Group One',
  libraryId: 'lib-1',
  enabled: true,
  slotCount: 2,
  interval: 'daily',
  order: 'sequential',
  surfaces: {
    usersHome: true,
    serverOwnerHome: false,
    libraryRecommended: false,
  },
  members: [{ kind: 'preExisting', configId: 'pre-1' }],
  ...over,
});

describe('draftProblem', () => {
  it('accepts a complete draft', () => {
    expect(draftProblem(draft())).toBeNull();
  });

  it('flags a blank name before anything else', () => {
    expect(draftProblem(draft({ name: '   ', libraryId: '' }))).toBe('name');
  });

  it('flags a missing library', () => {
    expect(draftProblem(draft({ libraryId: '' }))).toBe('library');
  });

  it('flags no surface', () => {
    expect(
      draftProblem(
        draft({
          surfaces: {
            usersHome: false,
            serverOwnerHome: false,
            libraryRecommended: false,
          },
        })
      )
    ).toBe('surface');
  });

  it('flags no members', () => {
    expect(draftProblem(draft({ members: [] }))).toBe('members');
  });
});

const cand = (key: string, selectable: boolean, missing = false) =>
  ({
    key,
    kind: 'preExisting',
    configId: key,
    selectable,
    missing,
  } as Candidate & { missing?: boolean });

describe('draftMembers', () => {
  it('keeps selected members that are no longer in Plex', () => {
    const rows = [cand('a', true), cand('gone', false, true), cand('c', false)];
    const out = draftMembers(rows, new Set(['a', 'gone', 'c']));
    expect(out.map((m) => m.configId)).toEqual(['a', 'gone']);
  });
});

describe('membersToKeep', () => {
  it('keeps members the server no longer lists, drops ones that cannot rotate', () => {
    const members = [{ key: 'a' }, { key: 'gone' }, { key: 'c' }];
    const out = membersToKeep(members, [cand('a', true), cand('c', false)]);
    expect(out.map((m) => m.key)).toEqual(['a', 'gone']);
  });
});

describe('homeRowAction', () => {
  it('a slot row always manages the rotation, never deletes', () => {
    expect(homeRowAction('collection', true, true, 'active')).toBe('manage');
    expect(homeRowAction('preExisting', true, true, 'active')).toBe('manage');
  });

  it('keeps the existing buttons off slot rows', () => {
    expect(homeRowAction('collection', false, false, 'active')).toBe('delete');
    expect(homeRowAction('preExisting', false, true, 'active')).toBe('manage');
    expect(homeRowAction('preExisting', false, false, 'active')).toBe('hide');
    expect(homeRowAction('hub', false, false, 'inactive')).toBeNull();
  });
});

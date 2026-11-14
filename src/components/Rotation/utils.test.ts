import { draftProblem } from '@app/components/Rotation/utils';
import type { GroupInput } from '@server/interfaces/api/rotationInterfaces';
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

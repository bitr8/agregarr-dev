import { describe, expect, it } from 'vitest';
import { getEssentialsVisibilityChange } from './collectionUtils';

const allOn = {
  usersHome: true,
  serverOwnerHome: true,
  libraryRecommended: true,
};
const allOff = {
  usersHome: false,
  serverOwnerHome: false,
  libraryRecommended: false,
};
const essentials = { type: 'plex', subtype: 'genre' };

describe('getEssentialsVisibilityChange', () => {
  it('sets all off when entering an Essentials subtype', () => {
    expect(
      getEssentialsVisibilityChange({ type: 'plex', subtype: '' }, essentials)
    ).toEqual(allOff);
  });

  it('restores all on when the subtype leaves Essentials', () => {
    expect(
      getEssentialsVisibilityChange(essentials, {
        type: 'plex',
        subtype: 'actors',
      })
    ).toEqual(allOn);
  });

  it('restores all on when the collection type changes away from plex', () => {
    expect(
      getEssentialsVisibilityChange(essentials, { type: 'trakt', subtype: '' })
    ).toEqual(allOn);
  });

  it('leaves visibility alone when Essentials is not involved', () => {
    expect(
      getEssentialsVisibilityChange(
        { type: 'trakt', subtype: 'a' },
        { type: 'plex', subtype: '' }
      )
    ).toBeUndefined();
  });
});

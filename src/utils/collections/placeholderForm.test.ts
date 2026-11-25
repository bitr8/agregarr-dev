import {
  placeholderInitialValues,
  placeholderSaveValues,
} from '@app/utils/collections/placeholderForm';
import { describe, expect, it } from 'vitest';

describe('placeholderSaveValues', () => {
  it('saves a released-days window of 0 as 0', () => {
    const out = placeholderSaveValues(
      {
        type: 'trakt',
        createPlaceholdersForMissing: true,
        placeholderReleasedDays: 0,
        placeholderDaysAhead: 30,
      },
      false
    );
    expect(out.placeholderReleasedDays).toBe(0);
    expect(out.placeholderDaysAhead).toBe(30);
  });

  it('saves a string "0" as 0 and blank as the default', () => {
    expect(
      placeholderSaveValues(
        {
          type: 'trakt',
          createPlaceholdersForMissing: true,
          placeholderReleasedDays: '0',
          placeholderDaysAhead: '',
        },
        false
      )
    ).toMatchObject({ placeholderReleasedDays: 0, placeholderDaysAhead: 90 });
  });

  it('writes Coming Soon window values even when the form flag is false', () => {
    expect(
      placeholderSaveValues(
        {
          type: 'comingsoon',
          createPlaceholdersForMissing: false,
          placeholderDaysAhead: 60,
          placeholderReleasedDays: 5,
        },
        false
      )
    ).toEqual({
      createPlaceholdersForMissing: true,
      placeholderDaysAhead: 60,
      placeholderReleasedDays: 5,
    });
  });

  it('drops the window values when placeholders are off', () => {
    expect(
      placeholderSaveValues(
        { type: 'trakt', createPlaceholdersForMissing: false },
        false
      )
    ).toEqual({
      createPlaceholdersForMissing: false,
      placeholderDaysAhead: undefined,
      placeholderReleasedDays: undefined,
    });
  });
});

describe('placeholderInitialValues', () => {
  it('reopens a stored 0 as 0', () => {
    expect(
      placeholderInitialValues({
        type: 'trakt',
        createPlaceholdersForMissing: true,
        placeholderReleasedDays: 0,
      }).placeholderReleasedDays
    ).toBe(0);
  });

  it('shows Coming Soon as enabled when the stored flag is false', () => {
    expect(
      placeholderInitialValues({
        type: 'comingsoon',
        createPlaceholdersForMissing: false,
      }).createPlaceholdersForMissing
    ).toBe(true);
  });

  it('defaults to 90 ahead and 14 released', () => {
    expect(placeholderInitialValues({ type: 'trakt' })).toEqual({
      createPlaceholdersForMissing: false,
      placeholderDaysAhead: 90,
      placeholderReleasedDays: 14,
    });
  });
});

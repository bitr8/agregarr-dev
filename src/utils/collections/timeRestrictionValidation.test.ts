import { describe, expect, it } from 'vitest';
import {
  getTimeRestrictionErrors,
  withoutBlankDateRanges,
} from './timeRestrictionValidation';

const week = (on: boolean) => ({
  monday: on,
  tuesday: on,
  wednesday: on,
  thursday: on,
  friday: on,
  saturday: on,
  sunday: on,
});

describe('getTimeRestrictionErrors', () => {
  it('ignores an always-active schedule', () => {
    expect(
      getTimeRestrictionErrors({
        alwaysActive: true,
        dateRanges: [{ startDate: '', endDate: '' }],
        weeklySchedule: week(false),
      })
    ).toEqual({});
  });

  it('flags blank and malformed range ends', () => {
    const e = getTimeRestrictionErrors({
      alwaysActive: false,
      dateRanges: [
        { startDate: '', endDate: '05-04' },
        { startDate: '1-4', endDate: '31-13' },
      ],
      weeklySchedule: week(true),
    });
    expect(e.dateRanges).toBeTruthy();
  });

  it('accepts DD-MM ranges, including ones that wrap the year', () => {
    expect(
      getTimeRestrictionErrors({
        alwaysActive: false,
        dateRanges: [{ startDate: '10-03', endDate: '05-04' }],
        weeklySchedule: week(true),
      })
    ).toEqual({});
    expect(
      getTimeRestrictionErrors({
        alwaysActive: false,
        dateRanges: [{ startDate: '01-12', endDate: '05-01' }],
      })
    ).toEqual({});
  });

  it('flags a weekly schedule with no day ticked', () => {
    const e = getTimeRestrictionErrors({
      alwaysActive: false,
      weeklySchedule: week(false),
    });
    expect(e.weeklySchedule).toBeTruthy();
  });

  it('allows no weekly schedule at all', () => {
    expect(getTimeRestrictionErrors({ alwaysActive: false })).toEqual({});
  });

  it('accepts single-digit day and month, as the server parses them', () => {
    expect(
      getTimeRestrictionErrors({
        alwaysActive: false,
        dateRanges: [{ startDate: '1-4', endDate: '5-12' }],
        weeklySchedule: week(true),
      })
    ).toEqual({});
  });

  it('still rejects out-of-range single-digit forms', () => {
    for (const bad of ['0-4', '1-0', '1-13', '32-1', '1-', '-4']) {
      expect(
        getTimeRestrictionErrors({
          alwaysActive: false,
          dateRanges: [{ startDate: bad, endDate: '05-04' }],
        }).dateRanges
      ).toBeTruthy();
    }
  });

  it('ignores a fully blank row but flags a half-filled one', () => {
    expect(
      getTimeRestrictionErrors({
        alwaysActive: false,
        dateRanges: [
          { startDate: '10-03', endDate: '05-04' },
          { startDate: '', endDate: '' },
        ],
        weeklySchedule: week(true),
      })
    ).toEqual({});
    expect(
      getTimeRestrictionErrors({
        alwaysActive: false,
        dateRanges: [{ startDate: '10-03', endDate: '' }],
      }).dateRanges
    ).toBeTruthy();
  });

  it('weekday rule is unchanged', () => {
    expect(
      getTimeRestrictionErrors({
        alwaysActive: false,
        dateRanges: [{ startDate: '', endDate: '' }],
        weeklySchedule: week(false),
      }).weeklySchedule
    ).toBeTruthy();
  });
});

describe('withoutBlankDateRanges', () => {
  it('drops rows with both ends empty and keeps the rest', () => {
    const tr = {
      alwaysActive: false,
      dateRanges: [
        { startDate: '10-03', endDate: '05-04' },
        { startDate: '', endDate: '' },
        { startDate: '1-2', endDate: '' },
      ],
    };
    expect(withoutBlankDateRanges(tr)?.dateRanges).toEqual([
      { startDate: '10-03', endDate: '05-04' },
      { startDate: '1-2', endDate: '' },
    ]);
  });

  it('passes undefined and range-less values through', () => {
    expect(withoutBlankDateRanges(undefined)).toBeUndefined();
    const tr = { alwaysActive: true };
    expect(withoutBlankDateRanges(tr)).toBe(tr);
  });
});

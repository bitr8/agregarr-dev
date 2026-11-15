import { TimeRestrictionUtils } from '@server/lib/collections/utils/TimeRestrictionUtils';
import { describe, expect, it } from 'vitest';

// Wednesday 15 July 2026, noon local time
const WED_15_JUL = new Date(2026, 6, 15, 12, 0, 0);

const days = (on: string[]) => ({
  monday: on.includes('monday'),
  tuesday: on.includes('tuesday'),
  wednesday: on.includes('wednesday'),
  thursday: on.includes('thursday'),
  friday: on.includes('friday'),
  saturday: on.includes('saturday'),
  sunday: on.includes('sunday'),
});

const evaluate = (
  restriction: Parameters<
    typeof TimeRestrictionUtils.evaluateTimeRestriction
  >[0]
) =>
  TimeRestrictionUtils.evaluateTimeRestriction(restriction, WED_15_JUL)
    .isActive;

describe('TimeRestrictionUtils.evaluateTimeRestriction', () => {
  it('is active with Always Active ticked', () => {
    expect(evaluate({ alwaysActive: true })).toBe(true);
  });

  it('is active when Always Active is unticked but no dates or days were saved', () => {
    expect(evaluate({ alwaysActive: false })).toBe(true);
    expect(evaluate({ alwaysActive: false, dateRanges: [] })).toBe(true);
  });

  it('follows the days alone', () => {
    expect(
      evaluate({ alwaysActive: false, weeklySchedule: days(['wednesday']) })
    ).toBe(true);
    expect(
      evaluate({ alwaysActive: false, weeklySchedule: days(['monday']) })
    ).toBe(false);
  });

  it('follows the date ranges alone', () => {
    expect(
      evaluate({
        alwaysActive: false,
        dateRanges: [{ startDate: '01-07', endDate: '31-07' }],
      })
    ).toBe(true);
    expect(
      evaluate({
        alwaysActive: false,
        dateRanges: [{ startDate: '01-12', endDate: '31-12' }],
      })
    ).toBe(false);
  });

  it('needs both to match when both are set', () => {
    const july = [{ startDate: '01-07', endDate: '31-07' }];
    expect(
      evaluate({
        alwaysActive: false,
        dateRanges: july,
        weeklySchedule: days(['wednesday']),
      })
    ).toBe(true);
    expect(
      evaluate({
        alwaysActive: false,
        dateRanges: july,
        weeklySchedule: days(['monday']),
      })
    ).toBe(false);
  });

  it('stays inactive when every day is unticked', () => {
    expect(evaluate({ alwaysActive: false, weeklySchedule: days([]) })).toBe(
      false
    );
  });
});

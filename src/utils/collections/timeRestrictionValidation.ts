export const DD_MM_PATTERN = /^(0?[1-9]|[12]\d|3[01])-(0?[1-9]|1[0-2])$/;

interface TimeRestrictionLike {
  alwaysActive?: boolean;
  dateRanges?: readonly { startDate?: string; endDate?: string }[];
  weeklySchedule?: object;
}

export interface TimeRestrictionErrors {
  dateRanges?: string;
  weeklySchedule?: string;
}

export const DATE_RANGE_ERROR =
  'Each date range needs a start and end date in DD-MM format';
export const NO_DAY_ERROR = 'Select at least one day of the week';

const isBlankRange = (r: { startDate?: string; endDate?: string }): boolean =>
  !r.startDate?.trim() && !r.endDate?.trim();

export const withoutBlankDateRanges = <T extends object>(
  tr: (T & TimeRestrictionLike) | undefined
): T | undefined =>
  tr?.dateRanges
    ? { ...tr, dateRanges: tr.dateRanges.filter((r) => !isBlankRange(r)) }
    : tr;

export const getTimeRestrictionErrors = (
  tr: TimeRestrictionLike | undefined
): TimeRestrictionErrors => {
  const errors: TimeRestrictionErrors = {};
  if (!tr || tr.alwaysActive !== false) return errors;

  const badRange = (tr.dateRanges ?? [])
    .filter((r) => !isBlankRange(r))
    .some(
      (r) =>
        !DD_MM_PATTERN.test(r.startDate ?? '') ||
        !DD_MM_PATTERN.test(r.endDate ?? '')
    );
  if (badRange) errors.dateRanges = DATE_RANGE_ERROR;

  if (tr.weeklySchedule && !Object.values(tr.weeklySchedule).some(Boolean)) {
    errors.weeklySchedule = NO_DAY_ERROR;
  }
  return errors;
};

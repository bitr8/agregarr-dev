export interface CalendarParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
}

export interface DateFormatDef {
  value: string;
  label: string;
  group: string;
  format: (p: CalendarParts, names: DateNames) => string;
}

interface DateNames {
  mon: string;
  monFull: string;
  dow: string;
  dowFull: string;
}

const MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];
const MONTHS_FULL = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const DAYS_FULL = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
];

const pad = (n: number) => String(n).padStart(2, '0');

export const DEFAULT_DATE_FORMAT = 'MMM DD';

export const DATE_FORMATS: readonly DateFormatDef[] = [
  {
    value: 'MMM DD',
    label: 'DEC 20',
    group: 'Short (No Year)',
    format: (p, n) => `${n.mon} ${pad(p.day)}`,
  },
  {
    value: 'DD MMM',
    label: '20 DEC',
    group: 'Short (No Year)',
    format: (p, n) => `${pad(p.day)} ${n.mon}`,
  },
  {
    value: 'MMM DD, YYYY',
    label: 'DEC 20, 2025',
    group: 'Short (With Year)',
    format: (p, n) => `${n.mon} ${pad(p.day)}, ${p.year}`,
  },
  {
    value: 'DD MMM YYYY',
    label: '20 DEC 2025',
    group: 'Short (With Year)',
    format: (p, n) => `${pad(p.day)} ${n.mon} ${p.year}`,
  },
  {
    value: 'MMMM DD, YYYY',
    label: 'December 20, 2025',
    group: 'Full Month Name',
    format: (p, n) => `${n.monFull} ${pad(p.day)}, ${p.year}`,
  },
  {
    value: 'DD MMMM YYYY',
    label: '20 December 2025',
    group: 'Full Month Name',
    format: (p, n) => `${pad(p.day)} ${n.monFull} ${p.year}`,
  },
  {
    value: 'MMM YYYY',
    label: 'DEC 2025',
    group: 'Month and Year',
    format: (p, n) => `${n.mon} ${p.year}`,
  },
  {
    value: 'MMMM YYYY',
    label: 'December 2025',
    group: 'Month and Year',
    format: (p, n) => `${n.monFull} ${p.year}`,
  },
  {
    value: 'YYYY-MM-DD',
    label: '2025-12-20',
    group: 'Numeric',
    format: (p) => `${p.year}-${pad(p.month)}-${pad(p.day)}`,
  },
  {
    value: 'YYYY/MM/DD',
    label: '2025/12/20',
    group: 'Numeric',
    format: (p) => `${p.year}/${pad(p.month)}/${pad(p.day)}`,
  },
  {
    value: 'MM/DD/YYYY',
    label: '12/20/2025',
    group: 'Numeric',
    format: (p) => `${pad(p.month)}/${pad(p.day)}/${p.year}`,
  },
  {
    value: 'DD/MM/YYYY',
    label: '20/12/2025',
    group: 'Numeric',
    format: (p) => `${pad(p.day)}/${pad(p.month)}/${p.year}`,
  },
  {
    value: 'DD-MM-YYYY',
    label: '20-12-2025',
    group: 'Numeric',
    format: (p) => `${pad(p.day)}-${pad(p.month)}-${p.year}`,
  },
  {
    value: 'DD/MM',
    label: '20/12',
    group: 'Numeric',
    format: (p) => `${pad(p.day)}/${pad(p.month)}`,
  },
  {
    value: 'D/M',
    label: '5/12',
    group: 'Numeric',
    format: (p) => `${p.day}/${p.month}`,
  },
  {
    value: 'MM/DD',
    label: '12/20',
    group: 'Numeric',
    format: (p) => `${pad(p.month)}/${pad(p.day)}`,
  },
  {
    value: 'M/D',
    label: '12/5',
    group: 'Numeric',
    format: (p) => `${p.month}/${p.day}`,
  },
  {
    value: 'DDD DD/MM',
    label: 'MON 20/12',
    group: 'With Weekday',
    format: (p, n) => `${n.dow} ${pad(p.day)}/${pad(p.month)}`,
  },
  {
    value: 'DDD D/M',
    label: 'MON 5/12',
    group: 'With Weekday',
    format: (p, n) => `${n.dow} ${p.day}/${p.month}`,
  },
  {
    value: 'DDD MM/DD',
    label: 'MON 12/20',
    group: 'With Weekday',
    format: (p, n) => `${n.dow} ${pad(p.month)}/${pad(p.day)}`,
  },
  {
    value: 'DDD M/D',
    label: 'MON 12/5',
    group: 'With Weekday',
    format: (p, n) => `${n.dow} ${p.month}/${p.day}`,
  },
  {
    value: 'DDDD',
    label: 'MONDAY',
    group: 'With Weekday',
    format: (_p, n) => n.dowFull,
  },
  {
    value: 'DDD',
    label: 'MON',
    group: 'With Weekday',
    format: (_p, n) => n.dow,
  },
];

export function formatCalendarParts(p: CalendarParts, format: string): string {
  const names: DateNames = {
    mon: MONTHS[p.month - 1],
    monFull: MONTHS_FULL[p.month - 1],
    dow: DAYS[p.weekday],
    dowFull: DAYS_FULL[p.weekday],
  };
  const def =
    DATE_FORMATS.find((f) => f.value === format) ??
    DATE_FORMATS.find((f) => f.value === DEFAULT_DATE_FORMAT);
  return def ? def.format(p, names) : '';
}

const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function partsFromYmd(y: number, m: number, d: number): CalendarParts {
  return {
    year: y,
    month: m,
    day: d,
    weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay(),
  };
}

// Bare dates are calendar dates; datetimes and Dates are read in `timeZone`.
export function calendarPartsInTimezone(
  value: Date | string,
  timeZone: string
): CalendarParts {
  if (typeof value === 'string') {
    const bare = BARE_DATE.exec(value);
    if (bare) {
      return partsFromYmd(Number(bare[1]), Number(bare[2]), Number(bare[3]));
    }
  }
  const instant = typeof value === 'string' ? new Date(value) : value;
  const [m, d, y] = instant
    .toLocaleString('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    .split('/');
  return partsFromYmd(Number(y), Number(m), Number(d));
}

export function formatDateInTimezone(
  value: Date | string,
  format: string,
  timeZone: string
): string {
  return formatCalendarParts(calendarPartsInTimezone(value, timeZone), format);
}

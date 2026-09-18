// react-intl throws if updateIntervalInSeconds is combined with a unit longer than hour.
export function nextRunRelativeTimeProps(secondsUntilNext: number): {
  value: number;
  unit: 'minute' | 'hour' | 'day';
  updateIntervalInSeconds?: number;
} {
  const hoursUntilNext = secondsUntilNext / 3600;

  if (hoursUntilNext < 1) {
    return {
      value: Math.floor(secondsUntilNext / 60),
      unit: 'minute',
      updateIntervalInSeconds: 10,
    };
  }

  if (hoursUntilNext <= 48) {
    return {
      value: Math.floor(hoursUntilNext),
      unit: 'hour',
      updateIntervalInSeconds: 60,
    };
  }

  return {
    value: Math.floor(secondsUntilNext / 86400),
    unit: 'day',
  };
}

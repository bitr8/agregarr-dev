import type { StatusResponse } from '@server/interfaces/api/settingsInterfaces';
import useSWR from 'swr';

export const resolveServerTimezone = (tz?: string): string => {
  if (!tz) return 'UTC';
  try {
    new Date().toLocaleString('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
};

export const useServerTimezone = (): string => {
  const { data } = useSWR<StatusResponse>('/api/v1/status');
  return resolveServerTimezone(data?.tz);
};

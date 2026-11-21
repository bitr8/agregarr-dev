import type { SettingsAboutResponse } from '@server/interfaces/api/settingsInterfaces';
import useSWR from 'swr';

export const useServerTimezone = (): string => {
  const { data } = useSWR<SettingsAboutResponse>('/api/v1/settings/about');
  return data?.tz || 'UTC';
};

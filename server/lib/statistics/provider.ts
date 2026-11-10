import { getSettings } from '@server/lib/settings';

export type StatisticsProvider = 'tautulli' | 'tracearr';

export function getStatisticsProvider(): StatisticsProvider {
  const tracearr = getSettings().tracearr;
  return tracearr?.enabled && tracearr.hostname && tracearr.apiKey
    ? 'tracearr'
    : 'tautulli';
}

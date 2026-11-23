export type ResolutionBucket = '4k' | 'hd' | 'sd' | 'unknown';

export const UNKNOWN_RESOLUTION = 'unknown';

const SD_VALUES = new Set(['576', '480', 'sd']);
const HD_VALUES = new Set(['720', '1080', '2k']);

export function resolutionBucket(resolution: string): ResolutionBucket {
  const r = resolution.toLowerCase();
  if (r === '4k') return '4k';
  if (HD_VALUES.has(r)) return 'hd';
  if (SD_VALUES.has(r)) return 'sd';
  if (/^\d+$/.test(r) && Number(r) < 720) return 'sd';
  return 'unknown';
}

const EXPLICIT_RANK: Record<string, number> = {
  '4k': 5,
  '2k': 4,
  '1080': 3,
  '720': 2,
};

// Higher is better; SD values tie, unknown ranks last.
export function bestVersionRank(resolution: string | undefined): number {
  const r = (resolution ?? '').toLowerCase();
  const explicit = EXPLICIT_RANK[r];
  if (explicit !== undefined) return explicit;
  return resolutionBucket(r) === 'sd' ? 1 : 0;
}

// CISA KEV entries for Plex Media Server; fixedIn from NVD's versionEndExcluding
const KNOWN_EXPLOITED: { fixedIn: string; cves: string[] }[] = [
  {
    fixedIn: '1.43.3.10861',
    cves: [
      'CVE-2026-96652',
      'CVE-2026-96654',
      'CVE-2026-96655',
      'CVE-2026-96656',
    ],
  },
  { fixedIn: '1.19.3', cves: ['CVE-2020-5741'] },
];

export const PLEX_MIN_SUPPORTED_VERSION = '1.43.3.10861';

/** False when the version is unknown or unparseable. */
export function plexVersionAtLeast(
  version: string | undefined,
  min: string
): boolean {
  if (!version) return false;
  const want = min.split('.').map(Number);
  const parts = version.split(/[.-]/).slice(0, want.length);
  if (!parts.every((p) => /^\d+$/.test(p))) return false;
  for (let i = 0; i < want.length; i++) {
    const have = Number(parts[i] ?? 0);
    if (have !== want[i]) return have > want[i];
  }
  return true;
}

/** Known exploited CVEs affecting this version; [] when patched or unparseable. */
export function exploitedCvesFor(version: string): string[] {
  if (!plexVersionAtLeast(version, '0.0.0')) return [];
  return KNOWN_EXPLOITED.filter(
    (e) => !plexVersionAtLeast(version, e.fixedIn)
  ).flatMap((e) => e.cves);
}

export function plexUnsupportedMessage(version: string): string {
  return `Agregarr supports Plex Media Server ${PLEX_MIN_SUPPORTED_VERSION} and newer. This server is running ${version}, which has security vulnerabilities that are being actively exploited (CISA KEV: ${exploitedCvesFor(
    version
  ).join(', ')}). Update Plex as soon as possible.`;
}

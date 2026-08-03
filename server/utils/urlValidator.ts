import dns from 'dns/promises';
import ipaddr from 'ipaddr.js';
import { URL } from 'url';

const ALLOWED_RANGES = new Set(['unicast']);

function isGloballyRoutable(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    return ALLOWED_RANGES.has(parsed.range());
  } catch {
    return false;
  }
}

export async function validateExternalUrl(url: string): Promise<URL> {
  const parsed = new URL(url);

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs are allowed');
  }

  if (parsed.username || parsed.password) {
    throw new Error('URLs with credentials are not allowed');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  const [addresses, addresses6] = await Promise.all([
    dns.resolve4(hostname).catch(() => [] as string[]),
    dns.resolve6(hostname).catch(() => [] as string[]),
  ]);
  const all = [...addresses, ...addresses6];

  if (all.length === 0) {
    throw new Error(`Cannot resolve hostname: ${hostname}`);
  }

  for (const addr of all) {
    if (!isGloballyRoutable(addr)) {
      throw new Error(
        'URLs pointing to private or reserved addresses are not allowed'
      );
    }
  }

  return parsed;
}

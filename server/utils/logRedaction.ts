const REDACTED = '[redacted]';

// Credential-named query/form params: X-Plex-Token=, api_key=, apikey=,
// accessToken=, clientSecret=, password= etc. The name must contain one of
// the credential words, so ratingKey=, parentRatingKey= and sectionKey= are
// untouched. Value charset excludes quotes and backslashes so redacting
// inside serialized JSON cannot break the JSON.
const PARAM_PATTERN =
  /\b([\w-]*(?:token|api_?key|secret|password|authorization)[\w-]*=)[^&\s"'\\]+/gi;

// Bare key= only when not preceded by a word character, so ?key= and &key=
// are caught but ratingKey= and grandparentRatingKey= are not.
const BARE_KEY_PATTERN = /(?<![\w-])(key=)[^&\s"'\\]+/gi;

// JSON properties with credential names: "plexToken":"abc", "apiKey": "x".
// Bare "key" is deliberately excluded - Plex metadata uses "key" for paths.
const JSON_KEY_PATTERN =
  /("[\w-]*(?:token|api_?key|secret|password|authorization|cookie)[\w-]*"\s*:\s*")(?:[^"\\]|\\.)*(")/gi;

// Same JSON properties one escape level deeper: when a stringified body is
// logged as part of a message, winston's json() escapes the inner quotes,
// producing \"plexToken\":\"SECRET\". The plain pattern above cannot see it.
// Value class must stay (?:[^"\\]|\\[\s\S])*? - lazy, non-overlapping
// alternatives. A separate \\\\ alternative overlaps with \\[^"] on
// backslash runs and backtracks exponentially when no closing \" follows
// (e.g. a Windows path in a truncated log line).
const ESCAPED_JSON_KEY_PATTERN =
  /(\\"[\w-]*(?:token|api_?key|secret|password|authorization|cookie)[\w-]*\\"\s*:\s*\\")(?:[^"\\]|\\[\s\S])*?(\\")/gi;

// Raw header form ("X-Plex-Token: abc") - the param pattern needs '=' and
// the JSON pattern needs quotes, so colon-separated headers slip both.
// Specific header names only; a generic name list would eat prose like
// "WAF token: expired". Minimum value length keeps it off short words.
const HEADER_PATTERN =
  /\b(x-plex-token|x-api-key|x-arr-api-key|proxy-authorization)\s*:\s*[\w.~+/-]{8,}/gi;

// Authorization scheme values. Minimum lengths stop prose like
// "Bearer of the news" from being mangled - real tokens are long.
const BEARER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/g;
const BASIC_AUTH_PATTERN = /\b(Basic\s+)[A-Za-z0-9+/=]{8,}/g;

// Credentials embedded in URLs: https://user:password@host, redis://:pw@host
const URL_USERINFO_PATTERN = /(\/\/[^\s/@:]*:)[^\s@/]+(@)/g;

// Literal secret values registered at settings load/save and PlexAPI
// construction. Catches secrets in contexts the patterns cannot predict
// (response bodies, command lines, stack traces).
const registeredSecrets = new Set<string>();
let secretList: string[] = [];

// Values shorter than this are too likely to collide with ordinary log
// content (and are not real credentials anyway).
const MIN_SECRET_LENGTH = 8;

export function registerLogSecrets(
  values: (string | undefined | null)[]
): void {
  for (const value of values) {
    if (
      typeof value === 'string' &&
      value.length >= MIN_SECRET_LENGTH &&
      !registeredSecrets.has(value)
    ) {
      registeredSecrets.add(value);
      secretList.push(value);
    }
  }
}

// Walks a settings object collecting string values stored under
// credential-named keys. Runs only on settings load/save, never per log line.
export function collectSecretValues(value: unknown, depth = 0): string[] {
  if (depth > 8 || value === null || typeof value !== 'object') {
    return [];
  }
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (
      typeof child === 'string' &&
      /token|api_?key|secret|password/i.test(key)
    ) {
      found.push(child);
    } else if (typeof child === 'object') {
      found.push(...collectSecretValues(child, depth + 1));
    }
  }
  return found;
}

export function scrubSecrets(input: string): string {
  if (!input || typeof input !== 'string') {
    return input;
  }
  try {
    let out = input
      .replace(PARAM_PATTERN, `$1${REDACTED}`)
      .replace(BARE_KEY_PATTERN, `$1${REDACTED}`)
      .replace(JSON_KEY_PATTERN, `$1${REDACTED}$2`)
      .replace(ESCAPED_JSON_KEY_PATTERN, `$1${REDACTED}$2`)
      .replace(HEADER_PATTERN, `$1: ${REDACTED}`)
      .replace(BEARER_PATTERN, `$1${REDACTED}`)
      .replace(BASIC_AUTH_PATTERN, `$1${REDACTED}`)
      .replace(URL_USERINFO_PATTERN, `$1${REDACTED}$2`);
    for (const secret of secretList) {
      if (out.includes(secret)) {
        out = out.split(secret).join(REDACTED);
      }
    }
    return out;
  } catch {
    // A formatter exception would crash whatever code was logging.
    // Fall back to the unscrubbed line - same exposure as before this existed.
    return input;
  }
}

// Test-only: clear registered values so cases do not leak into each other.
export function clearLogSecretsForTesting(): void {
  registeredSecrets.clear();
  secretList = [];
}

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./youtubeCookies', () => ({
  getYoutubeCookiesState: () => 'missing',
  youtubeCookiesPath: () => '/cfg/youtube-cookies.txt',
}));

import { searchYouTube } from './trailerDownload';

// Real child processes: a stand-in yt-dlp that behaves, and one that floods stdout.
const dir = mkdtempSync(path.join(tmpdir(), 'ytdlp-bound-'));
const script = (name: string, body: string): string => {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
};

let polite: string;
let flood: string;

beforeAll(() => {
  polite = script('polite', 'printf "abc\\tOne\\nxyz\\tTwo\\n"');
  flood = script('flood', 'head -c 1048576 /dev/zero | tr "\\0" x');
});

afterAll(() => {
  delete process.env.YT_DLP_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe('searchYouTube output bound (real processes)', () => {
  it('returns results from a well-behaved binary', async () => {
    process.env.YT_DLP_PATH = polite;
    await expect(searchYouTube('x', 2)).resolves.toEqual([
      { videoId: 'abc', title: 'One' },
      { videoId: 'xyz', title: 'Two' },
    ]);
  });

  it('kills a binary that floods stdout past the limit', async () => {
    process.env.YT_DLP_PATH = flood;
    await expect(searchYouTube('x', 2)).rejects.toThrow(/maxBuffer/);
  });
});

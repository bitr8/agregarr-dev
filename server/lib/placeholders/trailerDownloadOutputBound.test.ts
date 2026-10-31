import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./youtubeCookies', () => ({
  getYoutubeCookiesState: () => 'missing',
  youtubeCookiesPath: () => '/cfg/youtube-cookies.txt',
}));

import { downloadWithYtDlp, searchYouTube } from './trailerDownload';

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
let tooLong: string;

beforeAll(() => {
  polite = script('polite', 'printf "abc\\tOne\\nxyz\\tTwo\\n"');
  flood = script('flood', 'head -c 1048576 /dev/zero | tr "\\0" x');
  tooLong = script(
    'toolong',
    'echo "[download] Some Trailer does not pass filter (duration < 210)"; echo noise >&2; exit 101'
  );
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

describe('downloadWithYtDlp duration filter rejection', () => {
  it('reports exit 101 together with the filter message', async () => {
    process.env.YT_DLP_PATH = tooLong;
    await expect(
      downloadWithYtDlp('https://x', path.join(dir, 'out.mp4'), 210)
    ).rejects.toThrow(/code 101.*does not pass filter/s);
  });
});

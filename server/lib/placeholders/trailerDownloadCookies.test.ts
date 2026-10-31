import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, execFileMock, stateMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileMock: vi.fn(),
  stateMock: vi.fn(),
}));

vi.mock('child_process', () => ({ spawn: spawnMock, execFile: execFileMock }));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('./youtubeCookies', () => ({
  getYoutubeCookiesState: stateMock,
  youtubeCookiesPath: () => '/cfg/youtube-cookies.txt',
}));

import { downloadWithYtDlp, searchYouTube } from './trailerDownload';

type ExecCallback = (
  error: (Error & { code?: number | string }) | null,
  stdout: string,
  stderr: string
) => void;

function fakeProcess(exitCode = 0) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  setImmediate(() => proc.emit('close', exitCode));
  return proc;
}

function execFileReturning(
  stdout: string,
  stderr = '',
  error: Error | null = null
) {
  execFileMock.mockImplementation(
    (_file: string, _args: string[], _opts: unknown, cb: ExecCallback) =>
      cb(error, stdout, stderr)
  );
}

describe('downloadWithYtDlp cookies', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeProcess());
  });

  it.each(['invalid', 'missing'])('omits --cookies when %s', async (state) => {
    stateMock.mockReturnValue(state);
    await downloadWithYtDlp('https://youtu.be/x', '/tmp/out.mp4');
    expect(spawnMock.mock.calls[0][1]).not.toContain('--cookies');
  });

  it('passes --cookies when valid', async () => {
    stateMock.mockReturnValue('valid');
    await downloadWithYtDlp('https://youtu.be/x', '/tmp/out.mp4');
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args[args.indexOf('--cookies') + 1]).toBe(
      '/cfg/youtube-cookies.txt'
    );
  });
});

describe('downloadWithYtDlp argv', () => {
  beforeEach(() => {
    stateMock.mockReturnValue('missing');
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeProcess());
  });
  afterEach(() => {
    delete process.env.YT_DLP_PATH;
  });

  it('doubles % in the output path so yt-dlp does not expand it', async () => {
    await downloadWithYtDlp('https://youtu.be/x', '/tmp/100%(id)s_trailer.mp4');
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args[args.indexOf('-o') + 1]).toBe('/tmp/100%%(id)s_trailer.mp4');
  });

  it('keeps the binary from YT_DLP_PATH', async () => {
    process.env.YT_DLP_PATH = '/usr/local/bin/yt-dlp';
    await downloadWithYtDlp('https://youtu.be/x', '/tmp/out.mp4');
    expect(spawnMock.mock.calls[0][0]).toBe('/usr/local/bin/yt-dlp');
  });

  it('caps captured stderr instead of growing with the process', async () => {
    spawnMock.mockImplementation(() => {
      const proc = fakeProcess(1);
      process.nextTick(() => {
        for (let i = 0; i < 8; i++) {
          proc.stderr.emit('data', Buffer.alloc(32 * 1024, 'e'));
        }
      });
      return proc;
    });
    await expect(
      downloadWithYtDlp('https://youtu.be/x', '/tmp/out.mp4')
    ).rejects.toSatisfy((error: Error) => error.message.length < 100 * 1024);
  });
});

describe('searchYouTube', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });
  afterEach(() => {
    delete process.env.YT_DLP_PATH;
  });

  it('parses id/title lines and passes cookies to the search', async () => {
    stateMock.mockReturnValue('valid');
    execFileReturning('abc123\tDune\tTrailer\nxyz\tTwo\n');
    const results = await searchYouTube('Dune 2021 official trailer', 10);
    expect(results).toEqual([
      { videoId: 'abc123', title: 'Dune\tTrailer' },
      { videoId: 'xyz', title: 'Two' },
    ]);
    const [file, args, opts] = execFileMock.mock.calls[0] as [
      string,
      string[],
      { timeout: number; maxBuffer: number }
    ];
    expect(file).toBe('yt-dlp');
    expect(args).toContain('--cookies');
    expect(args[args.length - 1]).toBe('ytsearch10:Dune 2021 official trailer');
    expect(opts.timeout).toBe(30000);
    expect(opts.maxBuffer).toBe(256 * 1024);
  });

  it('uses the binary from YT_DLP_PATH', async () => {
    stateMock.mockReturnValue('missing');
    process.env.YT_DLP_PATH = '/usr/local/bin/yt-dlp';
    execFileReturning('');
    await searchYouTube('x', 10);
    expect(execFileMock.mock.calls[0][0]).toBe('/usr/local/bin/yt-dlp');
  });

  it.each([
    [999, 'ytsearch50:'],
    [0, 'ytsearch1:'],
    [-3, 'ytsearch1:'],
    [2.9, 'ytsearch2:'],
    [Number.NaN, 'ytsearch1:'],
  ])('clamps a limit of %s to %s', async (limit, prefix) => {
    stateMock.mockReturnValue('missing');
    execFileReturning('');
    await searchYouTube('x', limit);
    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args[args.length - 1].startsWith(prefix)).toBe(true);
  });

  it('collapses whitespace and caps the query length', async () => {
    stateMock.mockReturnValue('missing');
    execFileReturning('');
    await searchYouTube(`  Dune\n\n 2021 ${'x'.repeat(500)}`, 10);
    const args = execFileMock.mock.calls[0][1] as string[];
    const term = args[args.length - 1].replace('ytsearch10:', '');
    expect(term.startsWith('Dune 2021 x')).toBe(true);
    expect(term).not.toMatch(/\n/);
    expect(term.length).toBe(200);
  });

  it('rejects on a non-zero exit so the caller falls back', async () => {
    stateMock.mockReturnValue('missing');
    execFileReturning(
      '',
      'boom',
      Object.assign(new Error('Command failed'), { code: 1 })
    );
    await expect(searchYouTube('x', 10)).rejects.toThrow('code 1');
  });

  it('names a timeout instead of echoing the command line', async () => {
    stateMock.mockReturnValue('missing');
    execFileReturning(
      '',
      'partial',
      Object.assign(new Error('Command failed: yt-dlp --flat-playlist'), {
        code: null,
        killed: true,
        signal: 'SIGTERM',
      })
    );
    await expect(searchYouTube('x', 10)).rejects.toSatisfy(
      (error: Error) =>
        /timed out \(SIGTERM\): partial/.test(error.message) &&
        !error.message.includes('Command failed')
    );
  });

  it('rejects with the error message when the process never ran', async () => {
    stateMock.mockReturnValue('missing');
    execFileReturning(
      '',
      '',
      Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' })
    );
    await expect(searchYouTube('x', 10)).rejects.toThrow('ENOENT');
  });
});
